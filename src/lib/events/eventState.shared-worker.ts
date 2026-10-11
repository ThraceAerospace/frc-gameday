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
  | { type: "close" };

type EventRecord = {
  state: EventState;
  clients: Map<MessagePort, () => void>;
};

const events = new Map<string, EventRecord>();
const portSubscriptions = new Map<MessagePort, Set<string>>();

function postSnapshot(
  port: MessagePort,
  eventKey: string,
  snapshot: EventStateSnapshot,
) {
  try {
    port.postMessage({ type: "snapshot", eventKey, snapshot });
  } catch {
    // A closing tab must not interrupt delivery to other live clients.
  }
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
    record = { state: new EventState(eventKey, workerEventWebSocket), clients: new Map() };
    events.set(eventKey, record);
  }

  const listener = (snapshot: EventStateSnapshot) =>
    postSnapshot(port, eventKey, snapshot);
  const unsubscribe = record.state.subscribe(listener);
  record.clients.set(port, unsubscribe);
  subscribed.add(eventKey);
  postSnapshot(port, eventKey, record.state.getSnapshot());
}

function unsubscribe(port: MessagePort, eventKey: string) {
  const subscribed = portSubscriptions.get(port);
  if (!subscribed?.delete(eventKey)) return;

  const record = events.get(eventKey);
  const unsubscribeClient = record?.clients.get(port);
  if (record && unsubscribeClient) {
    record.clients.delete(port);
    unsubscribeClient();
    if (record.clients.size === 0) {
      events.delete(eventKey);
    }
  }

  if (subscribed.size === 0) portSubscriptions.delete(port);
}

function closePort(port: MessagePort) {
  for (const eventKey of [...(portSubscriptions.get(port) ?? [])]) {
    unsubscribe(port, eventKey);
  }
  portSubscriptions.delete(port);
  port.close();
}

function handleMessage(port: MessagePort, message: ClientMessage) {
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
  port.onmessage = (messageEvent: MessageEvent<ClientMessage>) => {
    handleMessage(port, messageEvent.data);
  };
  port.onmessageerror = () => closePort(port);
  port.start();
  port.postMessage({ type: "ready" });
};
