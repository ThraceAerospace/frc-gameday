"use strict";

import { EventState } from "./EventState";
import type { EventStateSnapshot } from "./EventState";
import { workerEventWebSocket } from "./workerRealtime";

type ClientMessage =
  | { type: "subscribe"; eventKey: string }
  | { type: "unsubscribe"; eventKey: string }
  | {
      type: "reload";
      eventKey: string;
      resource: "all" | "matches" | "statuses" | "alliances" | "oprs";
    }
  | { type: "subscribeCanonical"; eventKey: string }
  | { type: "unsubscribeCanonical"; eventKey: string }
  | { type: "close" }
  | { type: "ping"; nonce: number };

type EventRecord = {
  state?: EventState;
  clients: Map<MessagePort, () => void>;
  canonicalClients: Map<MessagePort, () => void>;
};

const events = new Map<string, EventRecord>();
const portSubscriptions = new Map<MessagePort, Set<string>>();
const portCanonicalSubscriptions = new Map<MessagePort, Set<string>>();
const portLastSeen = new Map<MessagePort, number>();
const PORT_IDLE_TIMEOUT = 120_000;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

function ensureWatchdog() {
  if (watchdogTimer !== null) return;
  watchdogTimer = setInterval(() => {
    const now = Date.now();
    for (const [port, lastSeen] of portLastSeen) {
      if (now - lastSeen > PORT_IDLE_TIMEOUT) closePort(port);
    }
    if (portLastSeen.size === 0 && watchdogTimer !== null) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }, 30_000);
}

function postSnapshot(port: MessagePort, eventKey: string, snapshot: EventStateSnapshot) {
  try { port.postMessage({ type: "snapshot", eventKey, snapshot }); }
  catch { /* A closing tab must not interrupt delivery to other live clients. */ }
}

function postCanonicalSnapshot(
  port: MessagePort,
  eventKey: string,
  value: { version: number; snapshot: import("@fieldview/domain").FieldViewEventSnapshot },
) {
  try {
    port.postMessage({
      type: "canonical-snapshot",
      eventKey,
      version: value.version,
      snapshot: value.snapshot,
    });
  } catch { /* A closing tab must not interrupt delivery to other live clients. */ }
}

function subscribe(port: MessagePort, eventKey: string) {
  if (!eventKey) return;

  let subscribed = portSubscriptions.get(port);
  if (!subscribed) {
    subscribed = new Set();
    portSubscriptions.set(port, subscribed);
  }
  if (subscribed.has(eventKey)) return;

  let record = events.get(eventKey);
  if (!record) {
    record = { clients: new Map(), canonicalClients: new Map() };
    events.set(eventKey, record);
  }
  if (!record.state) record.state = new EventState(eventKey, workerEventWebSocket);

  const listener = (snapshot: EventStateSnapshot) => postSnapshot(port, eventKey, snapshot);
  const unsubscribe = record.state.subscribe(listener);
  record.clients.set(port, unsubscribe);
  if (!record.canonicalClients.has(port)) {
    const unsubscribeCanonical = workerEventWebSocket.subscribeCanonicalSnapshot(
      eventKey, (value) => postCanonicalSnapshot(port, eventKey, value),
    );
    record.canonicalClients.set(port, unsubscribeCanonical);
  }
  subscribed.add(eventKey);
  postSnapshot(port, eventKey, record.state.getSnapshot());
  const canonical = workerEventWebSocket.getCanonicalSnapshot(eventKey);
  if (canonical) postCanonicalSnapshot(port, eventKey, canonical);
}

function unsubscribe(port: MessagePort, eventKey: string) {
  const subscribed = portSubscriptions.get(port);
  if (!subscribed?.delete(eventKey)) return;

  const record = events.get(eventKey);
  const unsubscribeClient = record?.clients.get(port);
  if (record && unsubscribeClient) {
    record.clients.delete(port);
    unsubscribeClient();
  }
  const unsubscribeCanonical = record?.canonicalClients.get(port);
  if (record && unsubscribeCanonical && !portCanonicalSubscriptions.get(port)?.has(eventKey)) {
    record.canonicalClients.delete(port);
    unsubscribeCanonical();
  }
  if (record && record.clients.size === 0 && record.canonicalClients.size === 0) events.delete(eventKey);
  if (subscribed.size === 0) portSubscriptions.delete(port);
}

function subscribeCanonical(port: MessagePort, eventKey: string) {
  if (!eventKey) return;
  let subscribed = portCanonicalSubscriptions.get(port);
  if (!subscribed) {
    subscribed = new Set();
    portCanonicalSubscriptions.set(port, subscribed);
  }
  if (subscribed.has(eventKey)) return;
  let record = events.get(eventKey);
  if (!record) {
    record = { clients: new Map(), canonicalClients: new Map() };
    events.set(eventKey, record);
  }
  if (!record.canonicalClients.has(port)) {
    const unsubscribe = workerEventWebSocket.subscribeCanonicalSnapshot(
      eventKey, (value) => postCanonicalSnapshot(port, eventKey, value),
    );
    record.canonicalClients.set(port, unsubscribe);
  }
  subscribed.add(eventKey);
  const canonical = workerEventWebSocket.getCanonicalSnapshot(eventKey);
  if (canonical) postCanonicalSnapshot(port, eventKey, canonical);
}

function unsubscribeCanonical(port: MessagePort, eventKey: string) {
  const subscribed = portCanonicalSubscriptions.get(port);
  if (!subscribed?.delete(eventKey)) return;
  const record = events.get(eventKey);
  const unsubscribe = record?.canonicalClients.get(port);
  if (record && unsubscribe && !portSubscriptions.get(port)?.has(eventKey)) {
    record.canonicalClients.delete(port);
    unsubscribe();
  }
  if (record && record.clients.size === 0 && record.canonicalClients.size === 0) events.delete(eventKey);
  if (subscribed.size === 0) portCanonicalSubscriptions.delete(port);
}

function closePort(port: MessagePort) {
  if (!portLastSeen.has(port)) return;
  portLastSeen.delete(port);
  workerEventWebSocket.release();
  for (const eventKey of [...(portSubscriptions.get(port) ?? [])]) unsubscribe(port, eventKey);
  for (const eventKey of [...(portCanonicalSubscriptions.get(port) ?? [])]) unsubscribeCanonical(port, eventKey);
  portSubscriptions.delete(port);
  portCanonicalSubscriptions.delete(port);
  port.close();
  if (portLastSeen.size === 0 && watchdogTimer !== null) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function handleMessage(port: MessagePort, message: ClientMessage) {
  if (!portLastSeen.has(port)) return;
  portLastSeen.set(port, Date.now());
  switch (message.type) {
    case "subscribe":
      subscribe(port, message.eventKey);
      break;
    case "unsubscribe":
      unsubscribe(port, message.eventKey);
      break;
    case "reload": {
      const state = events.get(message.eventKey)?.state;
      if (!state) return;
      switch (message.resource) {
        case "all":
          state.reloadAll();
          break;
        case "matches":
          state.reloadMatches();
          break;
        case "statuses":
          state.reloadStatuses();
          break;
        case "alliances":
          state.reloadAlliances();
          break;
        case "oprs":
          state.reloadOprs();
          break;
      }
      break;
    }
    case "subscribeCanonical":
      subscribeCanonical(port, message.eventKey);
      break;
    case "unsubscribeCanonical":
      unsubscribeCanonical(port, message.eventKey);
      break;
    case "ping":
      port.postMessage({ type: "pong", nonce: message.nonce });
      break;
    case "close":
      closePort(port);
      break;
  }
}

const sharedWorkerScope = globalThis as typeof globalThis & {
  onconnect?: (event: { ports: MessagePort[] }) => void;
};

sharedWorkerScope.onconnect = (event) => {
  const port = event.ports[0];
  if (!port) return;

  portSubscriptions.set(port, new Set());
  portLastSeen.set(port, Date.now());
  ensureWatchdog();
  workerEventWebSocket.retain();
  port.onmessage = (messageEvent: MessageEvent<ClientMessage>) => {
    handleMessage(port, messageEvent.data);
  };
  port.onmessageerror = () => closePort(port);
  port.start();
  port.postMessage({ type: "ready" });
};
