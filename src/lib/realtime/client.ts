"use client";

export type EventWebSocketMessage = {
  type: string;
  eventKey?: string;
  messageType?: string;
};

export type EventWebSocketStatus =
  | "connecting"
  | "connected"
  | "disconnected";

type EventHandler = (message: EventWebSocketMessage) => void;
type StatusHandler = (status: EventWebSocketStatus) => void;

class EventWebSocketManager {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1000;
  private started = false;

  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly statusHandlers = new Set<StatusHandler>();

  private status: EventWebSocketStatus = "disconnected";

  subscribe(eventKey: string, handler: EventHandler): () => void {
    if (!eventKey) {
      return () => {};
    }

    let handlers = this.handlers.get(eventKey);

    if (!handlers) {
      handlers = new Set();
      this.handlers.set(eventKey, handlers);
    }

    handlers.add(handler);

    this.ensureStarted();
    this.send({
      type: "subscribe",
      eventKey,
    });

    return () => {
      const current = this.handlers.get(eventKey);

      if (!current) {
        return;
      }

      current.delete(handler);

      if (current.size === 0) {
        this.handlers.delete(eventKey);
        this.send({
          type: "unsubscribe",
          eventKey,
        });
      }
    };
  }

  subscribeStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    this.ensureStarted();

    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  private ensureStarted() {
    if (this.started) {
      return;
    }

    this.started = true;
    this.connect();
  }

  private setStatus(status: EventWebSocketStatus) {
    if (this.status === status) {
      return;
    }

    this.status = status;

    for (const handler of this.statusHandlers) {
      handler(status);
    }
  }

  private connect() {
    if (typeof window === "undefined") {
      return;
    }

    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.setStatus("connecting");

    const protocol =
      window.location.protocol === "https:" ? "wss:" : "ws:";

    const socket = new WebSocket(
      `${protocol}//${window.location.host}/api/ws`,
    );

    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) {
        return;
      }

      this.reconnectDelay = 1000;
      this.setStatus("connected");

      for (const eventKey of this.handlers.keys()) {
        this.send({
          type: "subscribe",
          eventKey,
        });
      }
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) {
        return;
      }

      try {
        const message =
          JSON.parse(event.data) as EventWebSocketMessage;

        if (message.eventKey) {
          for (const handler of this.handlers.get(message.eventKey) ?? []) {
            handler(message);
          }
          return;
        }

        for (const handlers of this.handlers.values()) {
          for (const handler of handlers) {
            handler(message);
          }
        }
      } catch (error) {
        console.error(
          "EventWebSocketManager: invalid message",
          error,
        );
      }
    });

    socket.addEventListener("error", () => {
      if (this.socket === socket) {
        this.setStatus("disconnected");
      }
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = null;
      this.setStatus("disconnected");

      if (this.reconnectTimer !== null) {
        return;
      }

      const delay = this.reconnectDelay;

      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2,
          30_000,
        );
        this.connect();
      }, delay);
    });
  }

  private send(message: {
    type: "subscribe" | "unsubscribe";
    eventKey: string;
  }) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(message));
  }
}

export const eventWebSocket = new EventWebSocketManager();
