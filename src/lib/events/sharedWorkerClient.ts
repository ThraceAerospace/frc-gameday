"use client";

import type { EventStateSnapshot } from "./EventState";

type SnapshotListener = () => void;
type ReloadResource = "all" | "matches" | "statuses" | "alliances" | "oprs";

const snapshots = new Map<string, EventStateSnapshot>();
const listeners = new Map<string, Set<SnapshotListener>>();
let worker: SharedWorker | null = null;
let port: MessagePort | null = null;

function post(message: unknown) {
  if (!port) connect();
  port?.postMessage(message);
}

function handleWorkerMessage(event: MessageEvent) {
  const message = event.data as {
    type?: string;
    eventKey?: string;
    snapshot?: EventStateSnapshot;
  };

  if (message.type !== "snapshot" || !message.eventKey || !message.snapshot) {
    return;
  }

  snapshots.set(message.eventKey, message.snapshot);
  for (const listener of listeners.get(message.eventKey) ?? []) {
    listener();
  }
}

function connect() {
  if (port || typeof SharedWorker === "undefined") return;

  const nextWorker = new SharedWorker(
    new URL("./eventState.shared-worker.ts", import.meta.url),
    { name: "fieldview-live-runtime", type: "module" },
  );
  const nextPort = nextWorker.port;
  worker = nextWorker;
  port = nextPort;
  nextPort.onmessage = handleWorkerMessage;
  nextPort.onmessageerror = recover;
  nextWorker.addEventListener("error", recover);
  nextPort.start();

  for (const [eventKey, eventListeners] of listeners) {
    if (eventListeners.size > 0) {
      nextPort.postMessage({ type: "subscribe", eventKey });
    }
  }
}

function recover() {
  const oldPort = port;
  port = null;
  worker = null;
  oldPort?.close();
  connect();
}

export function getEventStateSnapshot(eventKey: string): EventStateSnapshot | undefined {
  return snapshots.get(eventKey);
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

  connect();
  if (isFirst) post({ type: "subscribe", eventKey });
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
    if (listeners.size === 0 && port) {
      port.postMessage({ type: "close" });
      port.close();
      port = null;
      worker = null;
    }
  };
}

export function reloadSharedEventState(
  eventKey: string,
  resource: ReloadResource,
) {
  if (!eventKey) return;
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
      getSnapshot: () => snapshots.get(eventKey) ?? EMPTY_SNAPSHOT,
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
