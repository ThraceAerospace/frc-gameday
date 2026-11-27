"use strict";

import type {
  FieldViewEventState,
  FieldViewEventAnalytics,
  FieldViewTeamEventState,
  FieldViewMatchAnalysis,
  FieldViewMatchFlags,
} from "@fieldview/domain";
type EventWebSocketStatus = "connecting" | "connected" | "disconnected";
type StatusHandler = (status: EventWebSocketStatus) => void;
export type CanonicalEventSnapshotData = {
  /** Event-owned state remains distinct from independently owned team-event states. */
  state: FieldViewEventState;
  team_states: FieldViewTeamEventState[];
};
export type CanonicalSnapshot = {
  version: number;
  snapshot: CanonicalEventSnapshotData;
  /** True only when the cache contains the complete composed snapshot, including team states. */
  complete?: boolean;
  etag?: string;
};
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
  pending_invalidation?: Record<string, unknown> | null;
  calculated_at: number | null;
  source_revision: number | null;
  publication: CanonicalAnalyticsPublicationPayload | null;
  etag?: string;
};
type AnalyticsHandler = (value: CanonicalAnalyticsPublication) => void;
type SnapshotHandler = (value: CanonicalSnapshot) => void; 

type PersistedRuntimeResource = {
  key: string;
  schemaVersion: 1;
  value: unknown;
  etag: string | null;
};

const RUNTIME_CACHE_DB = "fieldview-runtime-cache";
const RUNTIME_CACHE_STORE = "resources";
let runtimeCacheDatabase: Promise<IDBDatabase | null> | null = null;

function openRuntimeCache(): Promise<IDBDatabase | null> {
  // The canonical transport runs in a browser Window/Worker. Node 24 also
  // exposes IndexedDB, but opening it in the test runner keeps its event loop
  // alive and is not a browser cache.
  if (typeof self === "undefined" || typeof indexedDB === "undefined") return Promise.resolve(null);
  if (runtimeCacheDatabase) return runtimeCacheDatabase;
  runtimeCacheDatabase = new Promise((resolve) => {
    try {
      const request = indexedDB.open(RUNTIME_CACHE_DB, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(RUNTIME_CACHE_STORE)) {
          database.createObjectStore(RUNTIME_CACHE_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return runtimeCacheDatabase;
}

async function readPersistedResource(key: string): Promise<PersistedRuntimeResource | null> {
  const database = await openRuntimeCache();
  if (!database) return null;
  return new Promise((resolve) => {
    try {
      const request = database.transaction(RUNTIME_CACHE_STORE, "readonly")
        .objectStore(RUNTIME_CACHE_STORE).get(key);
      request.onsuccess = () => {
        const value = request.result as PersistedRuntimeResource | undefined;
        resolve(value?.schemaVersion === 1 ? value : null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function persistRuntimeResource(
  key: string,
  value: unknown,
  etag: string | undefined,
): Promise<void> {
  const database = await openRuntimeCache();
  if (!database) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(RUNTIME_CACHE_STORE, "readwrite");
      transaction.objectStore(RUNTIME_CACHE_STORE).put({
        key, schemaVersion: 1, value, etag: etag ?? null,
      } satisfies PersistedRuntimeResource);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


class WorkerEventWebSocket implements EventRealtimeTransport {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1_000;
  private readonly snapshotHandlers = new Map<string, Set<SnapshotHandler>>();
  private readonly analyticsHandlers = new Map<string, Set<AnalyticsHandler>>();
  private readonly analyticsPublications = new Map<string, CanonicalAnalyticsPublication>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly snapshots = new Map<string, CanonicalSnapshot>();
  private readonly snapshotHydrations = new Map<string, Promise<void>>();
  private readonly analyticsHydrations = new Map<string, Promise<void>>();
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

  subscribeCanonicalSnapshot(eventKey: string, handler: SnapshotHandler): () => void {
    if (!eventKey || !this.runtimeBaseUrl) return () => {};
    let handlers = this.snapshotHandlers.get(eventKey);
    if (!handlers) {
      handlers = new Set();
      this.snapshotHandlers.set(eventKey, handlers);
    }
    const first = (this.snapshotHandlers.get(eventKey)?.size ?? 0) === 0;
    handlers.add(handler);
    const cached = this.snapshots.get(eventKey);
    if (cached) queueMicrotask(() => { if (handlers?.has(handler)) handler(cached); });
    void this.hydrateSnapshot(eventKey);
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
      if ((this.snapshotHandlers.get(eventKey)?.size ?? 0) === 0) {
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
    void this.hydrateAnalytics(eventKey);
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

  private activeEventKeys(): Set<string> {
    return new Set(this.snapshotHandlers.keys());
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
    if (!this.runtimeBaseUrl) {
      this.setStatus("disconnected");
      return;
    }
    const socketUrl = new URL("/stream", this.runtimeBaseUrl);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
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
        this.handleRuntimeMessage(raw);
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
          (this.leases === 0 && this.snapshotHandlers.size === 0 && this.analyticsHandlers.size === 0) ||
          this.reconnectTimer !== null) return;
      const delay = this.reconnectDelay;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
        this.ensureConnected();
      }, delay);
    });
  }


  private hydrateSnapshot(eventKey: string): Promise<void> {
    if (this.snapshots.has(eventKey)) return Promise.resolve();
    const existing = this.snapshotHydrations.get(eventKey);
    if (existing) return existing;
    const hydration = (async () => {
      const record = await readPersistedResource("snapshot:" + eventKey);
      if (!record || !isRecord(record.value)) return;
      const value = record.value as unknown as CanonicalSnapshot;
      if (!Number.isSafeInteger(value.version) || value.version < 0 ||
          !isRecord(value.snapshot) || !isRecord(value.snapshot.state) ||
          !Array.isArray(value.snapshot.team_states)) return;
      const current = this.snapshots.get(eventKey);
      if (current && current.version >= value.version) return;
      const restored = { ...value, etag: record.etag ?? value.etag };
      this.snapshots.set(eventKey, restored);
      for (const handler of this.snapshotHandlers.get(eventKey) ?? []) handler(restored);
    })().catch(() => undefined).finally(() => this.snapshotHydrations.delete(eventKey));
    this.snapshotHydrations.set(eventKey, hydration);
    return hydration;
  }

  private hydrateAnalytics(eventKey: string): Promise<void> {
    if (this.analyticsPublications.has(eventKey)) return Promise.resolve();
    const existing = this.analyticsHydrations.get(eventKey);
    if (existing) return existing;
    const hydration = (async () => {
      const record = await readPersistedResource("analytics:" + eventKey);
      if (!record || !isRecord(record.value)) return;
      const value = record.value as unknown as CanonicalAnalyticsPublication;
      if (value.event_key !== eventKey || !Number.isSafeInteger(value.revision) || value.revision < 0) return;
      const current = this.analyticsPublications.get(eventKey);
      if (current && current.revision >= value.revision) return;
      const restored = { ...value, etag: record.etag ?? value.etag };
      this.analyticsPublications.set(eventKey, restored);
      for (const handler of this.analyticsHandlers.get(eventKey) ?? []) handler(restored);
    })().catch(() => undefined).finally(() => this.analyticsHydrations.delete(eventKey));
    this.analyticsHydrations.set(eventKey, hydration);
    return hydration;
  }

  private handleRuntimeMessage(message: Record<string, unknown>) {
    if (message.type === "pong" || message.type === "connected") return;
    if (message.type === "subscribed" && message.topic === "analytics" &&
        typeof message.event_key === "string") {
      void this.fetchCanonicalAnalytics(message.event_key);
      return;
    }
    if (message.type === "analytics.changed" && typeof message.event_key === "string") {
      const eventKey = message.event_key;
      const version = Number.isSafeInteger(message.version) && (message.version as number) >= 0
        ? message.version as number : undefined;
      const data = isRecord(message.data) ? message.data : null;
      const revision = data && Number.isSafeInteger(data.revision) && (data.revision as number) >= 0
        ? data.revision as number : null;
      if (message.protocol === 1 && message.schema_version === 1 &&
          message.resource === "event-analytics" && message.change === "snapshot" &&
          data && data.event_key === eventKey && revision !== null &&
          version !== undefined && revision === version &&
          (data.status === "pending" || data.status === "stale" ||
            data.status === "partial" || data.status === "succeeded" ||
            data.status === "failed")) {
        const current = this.analyticsPublications.get(eventKey);
        const etag = typeof message.etag === "string" ? message.etag : undefined;
        const isNewer = !current || revision > current.revision;
        const sameRevisionChanged = Boolean(
          current && revision === current.revision && etag && etag !== current.etag,
        );
        if (isNewer || sameRevisionChanged) {
          const publication = data as unknown as CanonicalAnalyticsPublication;
          const value = { ...publication, ...(etag ? { etag } : {}) };
          this.analyticsPublications.set(eventKey, value);
          void persistRuntimeResource("analytics:" + eventKey, value, value.etag);
          for (const handler of this.analyticsHandlers.get(eventKey) ?? []) handler(value);
        }
        return;
      }
      // Older runtimes may send revision-only notices. Recover conditionally;
      // a complete data-bearing publication never needs a follow-up GET.
      void this.fetchCanonicalAnalytics(eventKey, version);
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
      const version = Number.isSafeInteger(message.version) && (message.version as number) >= 0
        ? message.version as number : undefined;
      if ((this.snapshotHandlers.get(eventKey)?.size ?? 0) > 0) {
        const envelopeValid = message.protocol === 1 && message.schema_version === 1 &&
          message.resource === "event-snapshot" &&
          (message.change === "snapshot" || message.change === "patch");
        if (!envelopeValid) {
          void this.fetchCanonicalSnapshot(eventKey, version);
          return;
        }
        const data = isRecord(message.data) ? message.data : null;
        const state = isRecord(data?.state) && data.state.event_key === eventKey
          ? data.state as unknown as FieldViewEventState : null;
        const current = this.snapshots.get(eventKey);
        const teamState = isRecord(data?.team_state) &&
          typeof data.team_key === "string" &&
          (data.team_state as Record<string, unknown>).event_key === eventKey &&
          (data.team_state as Record<string, unknown>).team_key === data.team_key
          ? data.team_state as unknown as FieldViewTeamEventState : null;
        const canApplyTeamDelta = Boolean(
          message.change === "patch" && !state && current?.complete && teamState &&
          version !== undefined && version === current.version + 1 &&
          data?.team_state_pending !== true,
        );
        if (((message.change === "snapshot" && state) || canApplyTeamDelta) &&
            version !== undefined && (!current || version > current.version)) {
          let teamStates = current?.snapshot.team_states ?? [];
          if (teamState && typeof data?.team_key === "string") {
            const index = teamStates.findIndex((item) => item.team_key === data.team_key);
            teamStates = index < 0
              ? [...teamStates, teamState]
              : teamStates.map((item, itemIndex) => itemIndex === index ? teamState : item);
          }
          let nextState = state ?? current!.snapshot.state;
          if (data?.event_comparison_invalidated === true && isRecord(nextState.analytics)) {
            nextState = {
              ...nextState,
              analytics: { ...nextState.analytics, team_comparison: undefined },
            } as FieldViewEventState;
          }
          const rosterKeys = Array.isArray(nextState.teams)
            ? nextState.teams.flatMap((team) =>
                isRecord(team) && typeof team.key === "string" ? [team.key] : [])
            : null;
          const cachedTeamKeys = new Set(teamStates.map((item) => item.team_key));
          const rosterComplete = rosterKeys !== null &&
            rosterKeys.length === teamStates.length &&
            rosterKeys.every((teamKey) => cachedTeamKeys.has(teamKey));
          const complete = Boolean(
            current?.complete &&
            version === current.version + 1 &&
            data?.team_state_pending !== true &&
            rosterComplete &&
            (state !== null || teamState !== null),
          );
          const value: CanonicalSnapshot = {
            version,
            snapshot: { state: nextState, team_states: teamStates },
            complete,
            ...(complete && typeof message.etag === "string" ? { etag: message.etag } : {}),
          };
          this.snapshots.set(eventKey, value);
          void persistRuntimeResource("snapshot:" + eventKey, value, value.etag);
          for (const handler of this.snapshotHandlers.get(eventKey) ?? []) handler(value);
          if (!complete) {
            void this.fetchCanonicalSnapshot(eventKey, version);
          }
        } else {
          void this.fetchCanonicalSnapshot(eventKey, version);
        }
      }
    }
  }

  private async fetchCanonicalAnalytics(eventKey: string, expectedRevision?: number) {
    if (!this.runtimeBaseUrl) return;
    await this.hydrateAnalytics(eventKey);
    try {
      const url = new URL("/events/" + encodeURIComponent(eventKey) + "/analytics", this.runtimeBaseUrl);
      const current = this.analyticsPublications.get(eventKey);
      const headers = new Headers();
      if (current?.etag) headers.set("If-None-Match", current.etag);
      let response = await fetch(url, { cache: "no-store", headers });
      if (response.status === 304) {
        if (current && (expectedRevision === undefined || current.revision >= expectedRevision)) return;
        response = await fetch(url, { cache: "no-store" });
      }
      if (!response.ok) throw new Error("Analytics request failed: HTTP " + response.status);
      const value = await response.json() as CanonicalAnalyticsPublication;
      if (value.event_key !== eventKey || !Number.isSafeInteger(value.revision) || value.revision < 0) {
        throw new Error("Analytics response omitted a valid event identity or revision");
      }
      const next = { ...value, etag: response.headers.get("ETag") ?? undefined };
      const latest = this.analyticsPublications.get(eventKey);
      if (latest && next.revision < latest.revision) return;
      if (expectedRevision !== undefined && next.revision < expectedRevision) return;
      this.analyticsPublications.set(eventKey, next);
      void persistRuntimeResource("analytics:" + eventKey, next, next.etag);
      for (const handler of this.analyticsHandlers.get(eventKey) ?? []) handler(next);
    } catch (error) {
      console.warn("[SharedEventWorker] Canonical analytics recovery failed", eventKey, error);
    }
  }

  private async fetchCanonicalSnapshot(eventKey: string, expectedVersion?: number) {
    if (!this.runtimeBaseUrl) return;
    await this.hydrateSnapshot(eventKey);
    try {
      const url = new URL(`/events/${encodeURIComponent(eventKey)}/snapshot`, this.runtimeBaseUrl);
      const current = this.snapshots.get(eventKey);
      const headers = new Headers();
      if (current?.complete && current.etag) headers.set("If-None-Match", current.etag);
      let response = await fetch(url, { cache: "no-store", headers });
      if (response.status === 304) {
        if (current?.complete && (expectedVersion === undefined || current.version >= expectedVersion)) return;
        response = await fetch(url, { cache: "no-store" });
      }
      if (!response.ok) throw new Error(`Snapshot request failed: HTTP ${response.status}`);
      const version = Number(response.headers.get("X-FieldView-Snapshot-Version"));
      if (!Number.isSafeInteger(version) || version < 0) throw new Error("Snapshot response omitted a valid version");
      const payload = await response.json() as FieldViewEventState & {
        team_states?: FieldViewTeamEventState[] | null;
      };
      const { team_states, ...state } = payload;
      const normalizedTeamStates = team_states ?? [];
      const expectedTeamKeys = Array.isArray(state.teams)
        ? state.teams.flatMap((team) =>
            isRecord(team) && typeof team.key === "string" ? [team.key] : [])
        : null;
      const receivedTeamKeys = new Set(normalizedTeamStates.map((team) => team.team_key));
      const complete = expectedTeamKeys !== null &&
        expectedTeamKeys.length === normalizedTeamStates.length &&
        expectedTeamKeys.every((teamKey) => receivedTeamKeys.has(teamKey));
      const snapshot: CanonicalEventSnapshotData = {
        state,
        team_states: normalizedTeamStates,
      };
      const latest = this.snapshots.get(eventKey);
      if (latest && version < latest.version) return;
      if (expectedVersion !== undefined && version < expectedVersion) return;
      const value: CanonicalSnapshot = {
        version,
        snapshot,
        complete,
        etag: response.headers.get("ETag") ?? undefined,
      };
      this.snapshots.set(eventKey, value);
      void persistRuntimeResource("snapshot:" + eventKey, value, value.etag);
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
    if (this.leases > 0 || this.snapshotHandlers.size > 0 || this.analyticsHandlers.size > 0) return;
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
