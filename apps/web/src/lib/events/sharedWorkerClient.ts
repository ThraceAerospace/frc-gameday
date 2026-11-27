"use client";

import type { CanonicalEventSnapshotData, CanonicalAnalyticsPublication } from "./workerRealtime";

type SnapshotListener = () => void;
type EventWebSocketStatus = "connecting" | "connected" | "disconnected";

const canonicalSnapshots = new Map<string, { version: number; snapshot: CanonicalEventSnapshotData }>();
const canonicalListeners = new Map<string, Set<SnapshotListener>>();
const canonicalAnalytics = new Map<string, CanonicalAnalyticsPublication>();
const canonicalAnalyticsListeners = new Map<string, Set<SnapshotListener>>();
const runtimeStatusListeners = new Set<SnapshotListener>();
let canonicalRuntimeStatus: EventWebSocketStatus = "disconnected";
let port: MessagePort | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastPongAt = 0;
let heartbeatNonce = 0;
let liveRuntimeRefs = 0;

function handleWorkerMessage(event: MessageEvent) {
  const message = event.data as {
    type?: string;
    eventKey?: string;
    snapshot?: CanonicalEventSnapshotData;
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
      canonicalSnapshots.set(message.eventKey, { version: message.version, snapshot: message.snapshot });
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
  }
}

function connect() {
  if (port || typeof SharedWorker === "undefined") return;
  let nextWorker: SharedWorker;
  try {
    nextWorker = new SharedWorker(
      new URL("./eventState.shared-worker.ts", import.meta.url),
      { name: "fieldview-live-runtime", type: "module" },
    );
  } catch (error) {
    console.error("[FieldViewRuntime] SharedWorker is unavailable", error);
    canonicalRuntimeStatus = "disconnected";
    for (const listener of runtimeStatusListeners) listener();
    return;
  }
  const nextPort = nextWorker.port;
  port = nextPort;
  nextPort.onmessage = handleWorkerMessage;
  nextPort.onmessageerror = () => recover(nextPort);
  nextWorker.addEventListener("error", () => recover(nextPort));
  nextPort.start();
  lastPongAt = Date.now();
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!port) return;
    if (Date.now() - lastPongAt > 120_000) {
      recover(nextPort);
      return;
    }
    port.postMessage({ type: "ping", nonce: ++heartbeatNonce });
  }, 30_000);
  for (const [eventKey, listeners] of canonicalListeners) {
    if (listeners.size > 0) nextPort.postMessage({ type: "subscribeCanonical", eventKey });
  }
  for (const [eventKey, listeners] of canonicalAnalyticsListeners) {
    if (listeners.size > 0) nextPort.postMessage({ type: "subscribeCanonicalAnalytics", eventKey });
  }
}

function recover(expectedPort?: MessagePort) {
  if (expectedPort && port !== expectedPort) return;
  const oldPort = port;
  port = null;
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  try { oldPort?.postMessage({ type: "close" }); } catch { /* Worker may have terminated. */ }
  oldPort?.close();
  if (canonicalListeners.size > 0 || canonicalAnalyticsListeners.size > 0 ||
      runtimeStatusListeners.size > 0 || liveRuntimeRefs > 0) connect();
}

function post(message: unknown) {
  if (!port) connect();
  port?.postMessage(message);
}

export function getCanonicalEventSnapshot(
  eventKey: string,
): { version: number; snapshot: CanonicalEventSnapshotData } | undefined {
  return canonicalSnapshots.get(eventKey);
}

export function refreshCanonicalEventSnapshot(eventKey: string): void {
  if (eventKey) post({ type: "refreshCanonical", eventKey });
}

export function subscribeCanonicalEventSnapshot(
  eventKey: string,
  listener: SnapshotListener,
): () => void {
  if (!eventKey) return () => {};
  let listeners = canonicalListeners.get(eventKey);
  const first = !listeners || listeners.size === 0;
  if (!listeners) { listeners = new Set(); canonicalListeners.set(eventKey, listeners); }
  listeners.add(listener);
  const existingPort = port;
  connect();
  if (first && existingPort && port === existingPort) post({ type: "subscribeCanonical", eventKey });
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

export function getCanonicalEventAnalytics(eventKey: string): CanonicalAnalyticsPublication | undefined {
  return canonicalAnalytics.get(eventKey);
}

export function refreshCanonicalEventAnalytics(eventKey: string): void {
  if (eventKey) post({ type: "refreshCanonicalAnalytics", eventKey });
}

export function subscribeCanonicalEventAnalytics(eventKey: string, listener: SnapshotListener): () => void {
  if (!eventKey) return () => {};
  let listeners = canonicalAnalyticsListeners.get(eventKey);
  const first = !listeners || listeners.size === 0;
  if (!listeners) { listeners = new Set(); canonicalAnalyticsListeners.set(eventKey, listeners); }
  listeners.add(listener);
  const existingPort = port;
  connect();
  if (first && existingPort && port === existingPort) post({ type: "subscribeCanonicalAnalytics", eventKey });
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

export function registerSharedLiveRuntime(): () => void {
  liveRuntimeRefs += 1;
  connect();
  return () => {
    liveRuntimeRefs = Math.max(0, liveRuntimeRefs - 1);
    closePortIfIdle();
  };
}

function closePortIfIdle() {
  if (canonicalListeners.size || canonicalAnalyticsListeners.size ||
      runtimeStatusListeners.size || liveRuntimeRefs || !port) return;
  port.postMessage({ type: "close" });
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  port.close();
  port = null;
  worker = null;
}
