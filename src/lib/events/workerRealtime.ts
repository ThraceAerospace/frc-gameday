"use strict";

import type {
  EventRealtimeTransport,
} from "./EventState";
import type {
  EventWebSocketMessage,
  EventWebSocketStatus,
} from "@/lib/realtime/client";

type MessageHandler = (message: EventWebSocketMessage) => void;
type StatusHandler = (status: EventWebSocketStatus) => void;

class WorkerEventWebSocket implements EventRealtimeTransport {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1_000;
  private readonly handlers = new Map<string, Set<MessageHandler>>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private status: EventWebSocketStatus = "disconnected";
  private disposed = false;

  subscribe(eventKey: string, handler: MessageHandler): () => void {
    if (!eventKey) return () => {};
    let handlers = this.handlers.get(eventKey);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(eventKey, handlers);
    }
    const first = handlers.size === 0;
    handlers.add(handler);
    this.disposed = false;
    this.ensureConnected();
    if (first) this.send({ type: "subscribe", eventKey });

    return () => {
      const current = this.handlers.get(eventKey);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(eventKey);
        this.send({ type: "unsubscribe", eventKey });
      }
      if (this.handlers.size === 0) this.stop();
    };
  }

  subscribeStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    queueMicrotask(() => {
      if (this.statusHandlers.has(handler)) handler(this.status);
    });
    return () => this.statusHandlers.delete(handler);
  }

  private ensureConnected() {
    if (this.disposed) return;
    if (this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)) return;

    const scope = globalThis as typeof globalThis & {
      location?: { protocol: string; host: string };
    };
    const location = scope.location;
    if (!location) return;

    this.setStatus("connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${process.env.NEXT_PUBLIC_REMOTE_WEBSOCKET_URL || location.host}/api/ws`,
    );
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectDelay = 1_000;
      this.setStatus("connected");
      for (const eventKey of this.handlers.keys()) {
        this.send({ type: "subscribe", eventKey });
      }
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(event.data) as EventWebSocketMessage;
        if (message.eventKey) {
          for (const handler of this.handlers.get(message.eventKey) ?? []) handler(message);
        } else {
          for (const handlers of this.handlers.values()) {
            for (const handler of handlers) handler(message);
          }
        }
      } catch (error) {
        console.error("[SharedEventWorker] Invalid WebSocket message", error);
      }
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.setStatus("disconnected");
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setStatus("disconnected");
      if (this.disposed || this.handlers.size === 0 || this.reconnectTimer !== null) return;
      const delay = this.reconnectDelay;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
        this.ensureConnected();
      }, delay);
    });
  }

  private send(message: { type: "subscribe" | "unsubscribe"; eventKey: string }) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private setStatus(status: EventWebSocketStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const handler of this.statusHandlers) handler(status);
  }

  private stop() {
    this.disposed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    }
    this.setStatus("disconnected");
  }
}

export const workerEventWebSocket = new WorkerEventWebSocket();
