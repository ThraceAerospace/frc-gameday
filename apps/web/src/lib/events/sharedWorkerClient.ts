"use client";

import { EventState, type EventStateSnapshot } from "./EventState";
import { eventWebSocket, type EventWebSocketStatus } from "@/lib/realtime/client";
import type { FieldViewEventSnapshot } from "@fieldview/domain";
import type { CanonicalAnalyticsPublication } from "./workerRealtime";

type SnapshotListener = () => void;
type ReloadResource = "all" | "matches" | "statuses" | "alliances" | "oprs";

const snapshots = new Map<string, EventStateSnapshot>();
const listeners = new Map<string, Set<SnapshotListener>>();
const canonicalSnapshots = new Map<string, { version: number; snapshot: FieldViewEventSnapshot }>();
const canonicalListeners = new Map<string, Set<SnapshotListener>>();
const canonicalAnalytics = new Map<string, CanonicalAnalyticsPublication>();
const canonicalAnalyticsListeners = new Map<string, Set<SnapshotListener>>();
const runtimeStatusListeners = new Set<SnapshotListener>();
let canonicalRuntimeStatus: EventWebSocketStatus = "disconnected";
let worker: SharedWorker | null = null;
let port: MessagePort | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastPongAt = 0;
let heartbeatNonce = 0;
let liveRuntimeRefs = 0;
let fallbackMode = false;
let fallbackRuntimeUnsubscribe: (() => void) | null = null;
const fallbackStates = new Map<string, EventState>();

function post(message: unknown) {
  if (!port) connect();
  port?.postMessage(message);
}

function handleWorkerMessage(event: MessageEvent) {
  const message = event.data as {
    type?: string;
    eventKey?: string;
    snapshot?: EventStateSnapshot | FieldViewEventSnapshot;
    value?: CanonicalAnalyticsPublication;
    version?: number;
    status?: EventWebSocketStatus;
  };

  if (message.type === "pong") {
    lastPongAt = Date.now();
    return;
  }
  if (message.type === "runtime-status" &&
      (message.status === "connecting" || message.status === "connected" || message.status === "disconnected")) {
    canonicalRuntimeStatus = message.status;
    for (const listener of runtimeStatusListeners) listener();
    return;
  }
  if (message.type === "canonical-snapshot" && message.eventKey && message.snapshot &&
      typeof message.version === "number") {
    const previous = canonicalSnapshots.get(message.eventKey);
    if (!previous || message.version >= previous.version) {
      canonicalSnapshots.set(message.eventKey, {
        version: message.version,
        snapshot: message.snapshot as FieldViewEventSnapshot,
      });
      for (const listener of canonicalListeners.get(message.eventKey) ?? []) listener();
    }
    return;
  }
  if (message.type === "canonical-analytics" && message.eventKey && message.value) {
    const previous = canonicalAnalytics.get(message.eventKey);
    if (!previous || message.value.revision >= previous.revision) {
      canonicalAnalytics.set(message.eventKey, message.value);
      for (const listener of canonicalAnalyticsListeners.get(message.eventKey) ?? []) listener();
    }
    return;
  }
  if (message.type !== "snapshot" || !message.eventKey || !message.snapshot) return;
  snapshots.set(message.eventKey, message.snapshot as EventStateSnapshot);
  for (const listener of listeners.get(message.eventKey) ?? []) listener();
}

function connect() {
  if (port || fallbackMode) return;
  if (typeof SharedWorker === "undefined") {
    fallbackMode = true;
    return;
  }

  let nextWorker: SharedWorker;
  try {
    nextWorker = new SharedWorker(
      new URL("./eventState.shared-worker.ts", import.meta.url),
      { name: "fieldview-live-runtime", type: "module" },
    );
  } catch (error) {
    console.warn("[SharedEventState] SharedWorker unavailable; using per-tab fallback", error);
    fallbackMode = true;
    return;
  }
  const nextPort = nextWorker.port;
  worker = nextWorker;
  port = nextPort;
  nextPort.onmessage = handleWorkerMessage;
  nextPort.onmessageerror = () => {
    if (port === nextPort) recover();
  };
  nextWorker.addEventListener("error", () => {
    if (port === nextPort) recover();
  });
  nextPort.start();
  lastPongAt = Date.now();
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!port) return;
    if (Date.now() - lastPongAt > 120_000) {
      recover();
      return;
    }
    port.postMessage({ type: "ping", nonce: ++heartbeatNonce });
  }, 30_000);

  for (const [eventKey, eventListeners] of listeners) {
    if (eventListeners.size > 0) nextPort.postMessage({ type: "subscribe", eventKey });
  }
  for (const [eventKey, eventListeners] of canonicalListeners) {
    if (eventListeners.size > 0) nextPort.postMessage({ type: "subscribeCanonical", eventKey });
  }
  for (const [eventKey, eventListeners] of canonicalAnalyticsListeners) {
    if (eventListeners.size > 0) nextPort.postMessage({ type: "subscribeCanonicalAnalytics", eventKey });
  }
}

function recover() {
  const oldPort = port;
  port = null;
  worker = null;
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  try {
    oldPort?.postMessage({ type: "close" });
  } catch {
    // The worker may already have been terminated.
  }
  oldPort?.close();
  if (listeners.size > 0 || canonicalListeners.size > 0 || canonicalAnalyticsListeners.size > 0 || runtimeStatusListeners.size > 0 || liveRuntimeRefs > 0) connect();
}

function getFallbackState(eventKey: string): EventState {
  let state = fallbackStates.get(eventKey);
  if (!state) {
    state = new EventState(eventKey);
    fallbackStates.set(eventKey, state);
  }
  return state;
}

export function getEventStateSnapshot(eventKey: string): EventStateSnapshot | undefined {
  return fallbackMode
    ? fallbackStates.get(eventKey)?.getSnapshot()
    : snapshots.get(eventKey);
}

export function getCanonicalEventSnapshot(
  eventKey: string,
): { version: number; snapshot: FieldViewEventSnapshot } | undefined {
  return canonicalSnapshots.get(eventKey);
}

export function getCanonicalEventAnalytics(eventKey: string): CanonicalAnalyticsPublication | undefined {
  return canonicalAnalytics.get(eventKey);
}

export function subscribeCanonicalEventAnalytics(eventKey: string, listener: SnapshotListener): () => void {
  if (!eventKey) return () => {};
  let eventListeners = canonicalAnalyticsListeners.get(eventKey);
  const isFirst = !eventListeners || eventListeners.size === 0;
  if (!eventListeners) { eventListeners = new Set(); canonicalAnalyticsListeners.set(eventKey, eventListeners); }
  eventListeners.add(listener);
  const existingPort = port;
  connect();
  if (!fallbackMode && isFirst && existingPort && port === existingPort) post({ type: "subscribeCanonicalAnalytics", eventKey });
  listener();
  return () => {
    const current = canonicalAnalyticsListeners.get(eventKey);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      canonicalAnalyticsListeners.delete(eventKey);
      canonicalAnalytics.delete(eventKey);
      post({ type: "unsubscribeCanonicalAnalytics", eventKey });
    }
    closePortIfIdle();
  };
}
export function getCanonicalRuntimeStatus(): EventWebSocketStatus {
  return canonicalRuntimeStatus;
}

export function subscribeCanonicalRuntimeStatus(listener: SnapshotListener): () => void {
  runtimeStatusListeners.add(listener);
  connect();
  listener();
  return () => {
    runtimeStatusListeners.delete(listener);
    closePortIfIdle();
  };
}

export function refreshCanonicalEventSnapshot(eventKey: string): void {
  if (!eventKey) return;
  post({ type: "refreshCanonical", eventKey });
}

export function subscribeCanonicalEventSnapshot(
  eventKey: string,
  listener: SnapshotListener,
): () => void {
  if (!eventKey) return () => {};
  let eventListeners = canonicalListeners.get(eventKey);
  const isFirst = !eventListeners || eventListeners.size === 0;
  if (!eventListeners) {
    eventListeners = new Set();
    canonicalListeners.set(eventKey, eventListeners);
  }
  eventListeners.add(listener);
  const existingPort = port;
  connect();
  if (!fallbackMode && isFirst && existingPort && port === existingPort) {
    post({ type: "subscribeCanonical", eventKey });
  }
  listener();
  return () => {
    const current = canonicalListeners.get(eventKey);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      canonicalListeners.delete(eventKey);
      canonicalSnapshots.delete(eventKey);
      post({ type: "unsubscribeCanonical", eventKey });
    }
    closePortIfIdle();
  };
}

export function subscribeSharedEventState(
  eventKey: string,
  listener: SnapshotListener,
): () => void {
  if (!eventKey) return () => {};

  let eventListeners = listeners.get(eventKey);
  const isFirst = !eventListeners || eventListeners.size === 0;
  if (!eventListeners) {
    eventListeners = new Set();
    listeners.set(eventKey, eventListeners);
  }
  eventListeners.add(listener);

  const existingPort = port;
  connect();
  if (fallbackMode) {
    const fallbackState = getFallbackState(eventKey);
    const unsubscribeFallback = fallbackState.subscribe(() => listener());
    listener();
    return () => {
      unsubscribeFallback();
      const current = listeners.get(eventKey);
      current?.delete(listener);
      if (current?.size === 0) {
        listeners.delete(eventKey);
        fallbackStates.delete(eventKey);
      }
      closePortIfIdle();
    };
  }
  // A newly opened port replays all current subscriptions inside connect().
  // Send an explicit subscribe only when this port was already established.
  if (isFirst && existingPort && port === existingPort) {
    post({ type: "subscribe", eventKey });
  }
  listener();

  return () => {
    const current = listeners.get(eventKey);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(eventKey);
      post({ type: "unsubscribe", eventKey });
      snapshots.delete(eventKey);
    }
    closePortIfIdle();
  };
}

export function registerSharedLiveRuntime(): () => void {
  liveRuntimeRefs += 1;
  connect();
  if (fallbackMode && !fallbackRuntimeUnsubscribe) {
    fallbackRuntimeUnsubscribe = eventWebSocket.subscribeStatus(() => {});
  }
  return () => {
    liveRuntimeRefs = Math.max(0, liveRuntimeRefs - 1);
    if (liveRuntimeRefs === 0 && fallbackRuntimeUnsubscribe) {
      fallbackRuntimeUnsubscribe();
      fallbackRuntimeUnsubscribe = null;
    }
    closePortIfIdle();
  };
}

function closePortIfIdle() {
  if (listeners.size === 0 && canonicalListeners.size === 0 && canonicalAnalyticsListeners.size === 0 && runtimeStatusListeners.size === 0 && liveRuntimeRefs === 0 && port) {
      port.postMessage({ type: "close" });
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      port.close();
      port = null;
      worker = null;
    }
}

export function reloadSharedEventState(
  eventKey: string,
  resource: ReloadResource,
) {
  if (!eventKey) return;
  if (fallbackMode) {
    const state = fallbackStates.get(eventKey);
    if (!state) return;
    switch (resource) {
      case "all": state.reloadAll(); break;
      case "matches": state.reloadMatches(); break;
      case "statuses": state.reloadStatuses(); break;
      case "alliances": state.reloadAlliances(); break;
      case "oprs": state.reloadOprs(); break;
    }
    return;
  }
  post({ type: "reload", eventKey, resource });
}

export type EventStateController = {
  getSnapshot: () => EventStateSnapshot;
  reloadAll: () => void;
  reloadMatches: () => void;
  reloadStatuses: () => void;
  reloadAlliances: () => void;
  reloadOprs: () => void;
};

const controllers = new Map<string, EventStateController>();

export function getEventStateController(eventKey: string): EventStateController {
  let controller = controllers.get(eventKey);
  if (!controller) {
    controller = {
      getSnapshot: () => getEventStateSnapshot(eventKey) ?? EMPTY_SNAPSHOT,
      reloadAll: () => reloadSharedEventState(eventKey, "all"),
      reloadMatches: () => reloadSharedEventState(eventKey, "matches"),
      reloadStatuses: () => reloadSharedEventState(eventKey, "statuses"),
      reloadAlliances: () => reloadSharedEventState(eventKey, "alliances"),
      reloadOprs: () => reloadSharedEventState(eventKey, "oprs"),
    };
    controllers.set(eventKey, controller);
  }
  return controller;
}

const EMPTY_SNAPSHOT: EventStateSnapshot = {
  event: null,
  teams: [],
  matches: [],
  eventNextMatch: null,
  eventLastMatch: null,
  teamsStatuses: {},
  alliances: [],
  oprs: null,
  loading: true,
  error: null,
  websocketStatus: "disconnected",
  websocketStale: false,
  upcomingMatchKey: null,
  upcomingMatchTeamKeys: [],
  statboticsMatches: {},
};
