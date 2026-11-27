"use strict";

import { workerEventWebSocket } from "./workerRealtime";

type ClientMessage =
  | { type: "subscribeCanonical"; eventKey: string }
  | { type: "unsubscribeCanonical"; eventKey: string }
  | { type: "subscribeCanonicalAnalytics"; eventKey: string }
  | { type: "unsubscribeCanonicalAnalytics"; eventKey: string }
  | { type: "refreshCanonical"; eventKey: string }
  | { type: "refreshCanonicalAnalytics"; eventKey: string }
  | { type: "close" }
  | { type: "ping"; nonce: number };

type EventRecord = {
  canonicalClients: Map<MessagePort, () => void>;
  analyticsClients: Map<MessagePort, () => void>;
};

const events = new Map<string, EventRecord>();
const portCanonicalSubscriptions = new Map<MessagePort, Set<string>>();
const portLastSeen = new Map<MessagePort, number>();
const portStatusUnsubscribers = new Map<MessagePort, () => void>();
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

function recordFor(eventKey: string): EventRecord {
  let record = events.get(eventKey);
  if (!record) {
    record = { canonicalClients: new Map(), analyticsClients: new Map() };
    events.set(eventKey, record);
  }
  return record;
}

function postCanonicalSnapshot(
  port: MessagePort,
  eventKey: string,
  value: import("./workerRealtime").CanonicalSnapshot,
) {
  try {
    port.postMessage({ type: "canonical-snapshot", eventKey, version: value.version, snapshot: value.snapshot });
  } catch { /* A closing tab must not interrupt delivery to other live clients. */ }
}

function subscribeCanonical(port: MessagePort, eventKey: string) {
  if (!portStatusUnsubscribers.has(port)) {
    const unsubscribeStatus = workerEventWebSocket.subscribeStatus((status) => {
      try { port.postMessage({ type: "runtime-status", status }); } catch { /* closing port */ }
    });
    portStatusUnsubscribers.set(port, unsubscribeStatus);
  }
  if (!eventKey) return;
  let subscribed = portCanonicalSubscriptions.get(port);
  if (!subscribed) {
    subscribed = new Set();
    portCanonicalSubscriptions.set(port, subscribed);
  }
  if (subscribed.has(eventKey)) return;
  const record = recordFor(eventKey);
  if (!record.canonicalClients.has(port)) {
    const unsubscribe = workerEventWebSocket.subscribeCanonicalSnapshot(
      eventKey, (value) => postCanonicalSnapshot(port, eventKey, value),
    );
    record.canonicalClients.set(port, unsubscribe);
  }
  subscribed.add(eventKey);
  const current = workerEventWebSocket.getCanonicalSnapshot(eventKey);
  if (current) postCanonicalSnapshot(port, eventKey, current);
}

function unsubscribeCanonical(port: MessagePort, eventKey: string) {
  const subscribed = portCanonicalSubscriptions.get(port);
  if (!subscribed?.delete(eventKey)) return;
  const record = events.get(eventKey);
  const unsubscribe = record?.canonicalClients.get(port);
  if (record && unsubscribe) {
    record.canonicalClients.delete(port);
    unsubscribe();
  }
  if (record && record.canonicalClients.size === 0 && record.analyticsClients.size === 0) events.delete(eventKey);
  if (subscribed.size === 0) portCanonicalSubscriptions.delete(port);
}

function subscribeCanonicalAnalytics(port: MessagePort, eventKey: string) {
  if (!eventKey) return;
  const record = recordFor(eventKey);
  if (record.analyticsClients.has(port)) return;
  const unsubscribe = workerEventWebSocket.subscribeCanonicalAnalytics(eventKey, (value) => {
    try { port.postMessage({ type: "canonical-analytics", eventKey, value }); } catch { /* closing port */ }
  });
  record.analyticsClients.set(port, unsubscribe);
}

function unsubscribeCanonicalAnalytics(port: MessagePort, eventKey: string) {
  const record = events.get(eventKey);
  const unsubscribe = record?.analyticsClients.get(port);
  if (record && unsubscribe) {
    record.analyticsClients.delete(port);
    unsubscribe();
  }
  if (record && record.canonicalClients.size === 0 && record.analyticsClients.size === 0) events.delete(eventKey);
}

function closePort(port: MessagePort) {
  if (!portLastSeen.has(port)) return;
  portLastSeen.delete(port);
  portStatusUnsubscribers.get(port)?.();
  portStatusUnsubscribers.delete(port);
  workerEventWebSocket.release();
  for (const eventKey of [...(portCanonicalSubscriptions.get(port) ?? [])]) unsubscribeCanonical(port, eventKey);
  for (const [eventKey, record] of events) {
    if (record.analyticsClients.has(port)) unsubscribeCanonicalAnalytics(port, eventKey);
  }
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
    case "subscribeCanonical": subscribeCanonical(port, message.eventKey); break;
    case "unsubscribeCanonical": unsubscribeCanonical(port, message.eventKey); break;
    case "subscribeCanonicalAnalytics": subscribeCanonicalAnalytics(port, message.eventKey); break;
    case "unsubscribeCanonicalAnalytics": unsubscribeCanonicalAnalytics(port, message.eventKey); break;
    case "refreshCanonical": workerEventWebSocket.refreshCanonicalSnapshot(message.eventKey); break;
    case "refreshCanonicalAnalytics": workerEventWebSocket.refreshCanonicalAnalytics(message.eventKey); break;
    case "ping": port.postMessage({ type: "pong", nonce: message.nonce }); break;
    case "close": closePort(port); break;
  }
}

const sharedWorkerScope = globalThis as typeof globalThis & {
  onconnect?: (event: { ports: MessagePort[] }) => void;
};

sharedWorkerScope.onconnect = (event) => {
  const port = event.ports[0];
  if (!port) return;
  portCanonicalSubscriptions.set(port, new Set());
  portLastSeen.set(port, Date.now());
  ensureWatchdog();
  workerEventWebSocket.retain();
  port.onmessage = (messageEvent: MessageEvent<ClientMessage>) => handleMessage(port, messageEvent.data);
  port.onmessageerror = () => closePort(port);
  port.start();
  port.postMessage({ type: "ready" });
};
