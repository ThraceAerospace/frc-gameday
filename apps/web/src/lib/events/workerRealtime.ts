"use strict";

import type {
  FieldViewEventState,
  FieldViewEventAnalytics,
  FieldViewTeamEventAnalytics,
  FieldViewMatchAnalysis,
  FieldViewMatchFlags,
} from "@fieldview/domain";
import type { EventRealtimeTransport } from "./EventState";
import type { EventWebSocketMessage, EventWebSocketStatus } from "@/lib/realtime/client";

type MessageHandler = (message: EventWebSocketMessage) => void;
type StatusHandler = (status: EventWebSocketStatus) => void;
export type CanonicalSnapshot = { version: number; snapshot: FieldViewEventState };
export type CanonicalAnalyticsPublicationPayload = {
  sourceRevision: number;
  calculatedAt: number;
  analyticsRevision?: number;
  matches: Array<{
    key: string;
    analysis?: FieldViewMatchAnalysis;
    flags?: FieldViewMatchFlags;
  }>;
  eventAnalytics?: FieldViewEventAnalytics;
};

export type CanonicalAnalyticsPublication = {
  event_key: string;
  revision: number;
  status: string;
  due_at: number | null;
  calculated_at: number | null;
  source_revision: number | null;
  publication: CanonicalAnalyticsPublicationPayload | null;
};
type AnalyticsHandler = (value: CanonicalAnalyticsPublication) => void;
type SnapshotHandler = (value: CanonicalSnapshot) => void;

class WorkerEventWebSocket implements EventRealtimeTransport {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1_000;
  private readonly handlers = new Map<string, Set<MessageHandler>>();
  private readonly snapshotHandlers = new Map<string, Set<SnapshotHandler>>();
  private readonly analyticsHandlers = new Map<string, Set<AnalyticsHandler>>();
  private readonly analyticsPublications = new Map<string, CanonicalAnalyticsPublication>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly snapshots = new Map<string, CanonicalSnapshot>();
  private readonly sentSubscriptions = new Set<string>();
  private readonly acknowledgedSubscriptions = new Set<string>();
  private readonly runtimeBaseUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL?.replace(/\/+$/, "") || null;
  private status: EventWebSocketStatus = "disconnected";
  private disposed = false;
  private leases = 0;

  retain(): void {
    this.leases += 1;
    this.disposed = false;
    this.ensureConnected();
  }

  release(): void {
    this.leases = Math.max(0, this.leases - 1);
    this.stopIfIdle();
  }

  subscribe(eventKey: string, handler: MessageHandler): () => void {
    if (!eventKey) return () => {};
    let handlers = this.handlers.get(eventKey);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(eventKey, handlers);
    }
    const first = !this.hasEventStateSubscription(eventKey);
    handlers.add(handler);
    this.disposed = false;
    this.ensureConnected();
    if (first) this.sendSubscription("event-state", eventKey, true);

    return () => {
      const current = this.handlers.get(eventKey);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.handlers.delete(eventKey);
      if (!this.hasEventStateSubscription(eventKey)) {
        this.sendSubscription("event-state", eventKey, false);
      }
      this.stopIfIdle();
    };
  }

  subscribeCanonicalSnapshot(eventKey: string, handler: SnapshotHandler): () => void {
    if (!eventKey || !this.runtimeBaseUrl) return () => {};
    let handlers = this.snapshotHandlers.get(eventKey);
    if (!handlers) {
      handlers = new Set();
      this.snapshotHandlers.set(eventKey, handlers);
    }
    const hadSubscription = this.hasEventStateSubscription(eventKey);
    const first = !hadSubscription;
    handlers.add(handler);
    const cached = this.snapshots.get(eventKey);
    if (cached) queueMicrotask(() => { if (handlers?.has(handler)) handler(cached); });
    this.disposed = false;
    this.ensureConnected();
    if (first) this.sendSubscription("event-state", eventKey, true);
    else if (!cached && this.acknowledgedSubscriptions.has("event-state:" + eventKey)) {
      void this.fetchCanonicalSnapshot(eventKey);
    }

    return () => {
      const current = this.snapshotHandlers.get(eventKey);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.snapshotHandlers.delete(eventKey);
      if (!this.hasEventStateSubscription(eventKey)) {
        this.sendSubscription("event-state", eventKey, false);
      }
      this.stopIfIdle();
    };
  }

  subscribeCanonicalAnalytics(eventKey: string, handler: AnalyticsHandler): () => void {
    if (!eventKey || !this.runtimeBaseUrl) return () => {};
    let handlers = this.analyticsHandlers.get(eventKey);
    if (!handlers) { handlers = new Set(); this.analyticsHandlers.set(eventKey, handlers); }
    const first = handlers.size === 0;
    handlers.add(handler);
    const cached = this.analyticsPublications.get(eventKey);
    if (cached) queueMicrotask(() => { if (handlers?.has(handler)) handler(cached); });
    this.disposed = false;
    this.ensureConnected();
    if (first) this.sendSubscription("analytics", eventKey, true);
    return () => {
      const current = this.analyticsHandlers.get(eventKey);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.analyticsHandlers.delete(eventKey);
        this.analyticsPublications.delete(eventKey);
        this.sendSubscription("analytics", eventKey, false);
      }
      this.stopIfIdle();
    };
  }

  refreshCanonicalAnalytics(eventKey: string): void {
    if (eventKey && (this.analyticsHandlers.get(eventKey)?.size ?? 0) > 0) {
      void this.fetchCanonicalAnalytics(eventKey);
    }
  }

  getCanonicalAnalytics(eventKey: string): CanonicalAnalyticsPublication | undefined {
    return this.analyticsPublications.get(eventKey);
  }
  getCanonicalSnapshot(eventKey: string): CanonicalSnapshot | undefined {
    return this.snapshots.get(eventKey);
  }

  refreshCanonicalSnapshot(eventKey: string): void {
    if (eventKey && (this.snapshotHandlers.get(eventKey)?.size ?? 0) > 0) {
      void this.fetchCanonicalSnapshot(eventKey);
    }
  }

  subscribeStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    queueMicrotask(() => {
      if (this.statusHandlers.has(handler)) handler(this.status);
    });
    return () => this.statusHandlers.delete(handler);
  }

  private hasEventStateSubscription(eventKey: string): boolean {
    return (this.handlers.get(eventKey)?.size ?? 0) > 0 ||
      (this.snapshotHandlers.get(eventKey)?.size ?? 0) > 0;
  }

  private activeEventKeys(): Set<string> {
    return new Set([...this.handlers.keys(), ...this.snapshotHandlers.keys()]);
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
    const socketUrl = this.runtimeBaseUrl
      ? new URL("/stream", this.runtimeBaseUrl)
      : new URL(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${process.env.NEXT_PUBLIC_REMOTE_WEBSOCKET_URL || location.host}/api/ws`,
      );
    if (this.runtimeBaseUrl) socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(socketUrl.toString());
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectDelay = 1_000;
      this.sentSubscriptions.clear();
      this.acknowledgedSubscriptions.clear();
      this.setStatus("connected");
      for (const eventKey of this.activeEventKeys()) this.sendSubscription("event-state", eventKey, true);
      for (const eventKey of this.analyticsHandlers.keys()) this.sendSubscription("analytics", eventKey, true);
      if (this.runtimeBaseUrl) {
        if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          if (this.socket === socket && socket.readyState === WebSocket.OPEN) socket.send("ping");
        }, 30_000);
      }
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      try {
        const raw = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (this.runtimeBaseUrl) {
          this.handleRuntimeMessage(raw);
        } else {
          const message = raw as EventWebSocketMessage;
          if (message.eventKey) {
            for (const handler of this.handlers.get(message.eventKey) ?? []) handler(message);
          } else {
            for (const handlers of this.handlers.values()) for (const handler of handlers) handler(message);
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
      this.sentSubscriptions.clear();
      this.acknowledgedSubscriptions.clear();
      if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.setStatus("disconnected");
      if (this.disposed ||
          (this.leases === 0 && this.handlers.size === 0 && this.snapshotHandlers.size === 0 && this.analyticsHandlers.size === 0) ||
          this.reconnectTimer !== null) return;
      const delay = this.reconnectDelay;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
        this.ensureConnected();
      }, delay);
    });
  }

  private handleRuntimeMessage(message: Record<string, unknown>) {
    if (message.type === "pong" || message.type === "connected") return;
    if (message.type === "subscribed" && message.topic === "analytics" &&
        typeof message.event_key === "string") {
      void this.fetchCanonicalAnalytics(message.event_key);
      return;
    }
    if (message.type === "analytics.changed" && typeof message.event_key === "string") {
      void this.fetchCanonicalAnalytics(message.event_key, typeof message.version === "number" ? message.version : undefined);
      return;
    }
    if (message.type === "subscribed" && message.topic === "event-state" &&
        typeof message.event_key === "string") {
      this.acknowledgedSubscriptions.add("event-state:" + message.event_key);
      if ((this.snapshotHandlers.get(message.event_key)?.size ?? 0) > 0) {
        void this.fetchCanonicalSnapshot(message.event_key);
      }
      return;
    }
    if (message.type === "snapshot.changed" && typeof message.event_key === "string") {
      const eventKey = message.event_key;
      this.acknowledgedSubscriptions.add("event-state:" + eventKey);
      const version = typeof message.version === "number" ? message.version : undefined;
      const eventMessage: EventWebSocketMessage = {
        type: "snapshot.changed",
        eventKey,
        ...(version === undefined ? {} : { version }),
      };
      for (const handler of this.handlers.get(eventKey) ?? []) handler(eventMessage);
      if ((this.snapshotHandlers.get(eventKey)?.size ?? 0) > 0) {
        void this.fetchCanonicalSnapshot(eventKey, version);
      }
    }
  }

  private async fetchCanonicalAnalytics(eventKey: string, expectedRevision?: number) {
    if (!this.runtimeBaseUrl) return;
    try {
      const url = new URL("/events/" + encodeURIComponent(eventKey) + "/analytics", this.runtimeBaseUrl);
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("Analytics request failed: HTTP " + response.status);
      const value = await response.json() as CanonicalAnalyticsPublication;
      if (value.event_key !== eventKey || !Number.isSafeInteger(value.revision) || value.revision < 0) {
        throw new Error("Analytics response omitted a valid event identity or revision");
      }
      const current = this.analyticsPublications.get(eventKey);
      if (current && value.revision < current.revision) return;
      if (expectedRevision !== undefined && value.revision < expectedRevision) return;
      this.analyticsPublications.set(eventKey, value);
      for (const handler of this.analyticsHandlers.get(eventKey) ?? []) handler(value);
    } catch (error) {
      console.warn("[SharedEventWorker] Canonical analytics recovery failed", eventKey, error);
    }
  }
  private async fetchCanonicalSnapshot(eventKey: string, expectedVersion?: number) {
    if (!this.runtimeBaseUrl) return;
    try {
      const url = new URL(`/events/${encodeURIComponent(eventKey)}/snapshot`, this.runtimeBaseUrl);
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Snapshot request failed: HTTP ${response.status}`);
      const version = Number(response.headers.get("X-FieldView-Snapshot-Version"));
      if (!Number.isSafeInteger(version) || version < 0) throw new Error("Snapshot response omitted a valid version");
      const snapshot = await response.json() as FieldViewEventState;
      const current = this.snapshots.get(eventKey);
      if (current && version < current.version) return;
      if (expectedVersion !== undefined && version < expectedVersion) {
        // The revision notification is newer than this read; keep the last
        // good snapshot and let the next notification/reconnect recover it.
        return;
      }
      const value = { version, snapshot };
      this.snapshots.set(eventKey, value);
      for (const handler of this.snapshotHandlers.get(eventKey) ?? []) handler(value);
    } catch (error) {
      console.warn("[SharedEventWorker] Canonical snapshot recovery failed", eventKey, error);
    }
  }

  private sendSubscription(topic: "event-state" | "analytics", eventKey: string, subscribe: boolean) {
    const key = topic + ":" + eventKey;
    if (subscribe) {
      if (this.sentSubscriptions.has(key)) return;
      this.sentSubscriptions.add(key);
    } else {
      if (!this.sentSubscriptions.has(key)) return;
      this.sentSubscriptions.delete(key);
      this.acknowledgedSubscriptions.delete(key);
    }
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.runtimeBaseUrl) {
      this.socket.send(JSON.stringify({
        type: subscribe ? "subscribe" : "unsubscribe",
        topic,
        event_key: eventKey,
      }));
    } else if (topic === "event-state") {
      this.socket.send(JSON.stringify({ type: subscribe ? "subscribe" : "unsubscribe", eventKey }));
    }
  }

  private setStatus(status: EventWebSocketStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const handler of this.statusHandlers) handler(status);
  }

  private stopIfIdle() {
    if (this.leases > 0 || this.handlers.size > 0 || this.snapshotHandlers.size > 0 || this.analyticsHandlers.size > 0) return;
    this.stop();
  }

  private stop() {
    this.disposed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.sentSubscriptions.clear();
    this.acknowledgedSubscriptions.clear();
    if (socket) socket.close();
    this.setStatus("disconnected");
  }
}

export const workerEventWebSocket = new WorkerEventWebSocket();
