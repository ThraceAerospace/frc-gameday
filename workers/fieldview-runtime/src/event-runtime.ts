import { TBAApiClient } from "../../../packages/providers/tba/src/client.ts";
import { TBA_ENDPOINTS } from "../../../packages/providers/tba/src/endpoints.ts";
import { StatboticsApiClient } from "../../../packages/providers/statbotics/src/client.ts";
import { STATBOTICS_ENDPOINTS } from "../../../packages/providers/statbotics/src/endpoints.ts";
import {
  applyPollResponse,
  applyWebhookUpdate,
  createEndpointState,
  createPollRequestSnapshot,
  type EndpointState,
} from "./endpoint-state.ts";
import type {
  DurableObjectStateLike,
  DurableObjectTransactionLike,
  RuntimeEnvironment,
} from "./cloudflare.ts";
import { reconcilePolledEndpoint, reconcileWebhookEndpoint } from "./reconciliation.ts";
import { createProviderSourceVersion } from "./source-record.ts";
import type { TBAEliminationAlliance, TBAEvent, TBAEventOPRs, TBAEventPredictions, TBAEventTeamStatuses, TBAMatch, TBATeam } from "../../../packages/providers/tba/src/types.ts";
import type { StatboticsMatch } from "../../../packages/providers/statbotics/src/types.ts";
import type { EventKey } from "../../../packages/domain/src/ids.ts";
import type { FieldViewSourceRecordMetadata } from "../../../packages/domain/src/source-metadata.ts";
import { normalizeFieldViewEventSnapshot } from "../../../packages/domain/src/normalization/event-snapshot.ts";

interface PollTask {
  endpoint: string;
  dueAt: number;
  intervalMs: number | null;
  generation: number;
  attempts: number;
  /** False means at-most-once execution with no retry after provider failure. */
  retryOnFailure: boolean;
  /** Optional finite attempt budget for causally-triggered one-shot work. */
  maxAttempts?: number;
}

const TASK_PREFIX = "task:"
const ENDPOINT_PREFIX = "endpoint:";
const SOURCE_PREFIX = "source:";

function endpointStorageKey(endpoint: string): string {
  return `${ENDPOINT_PREFIX}${endpoint}`;
}

function taskStorageKey(endpoint: string): string {
  return `${TASK_PREFIX}${endpoint}`;
}

function sourceStorageKey(endpoint: string, revision: number): string {
  return `${SOURCE_PREFIX}${endpoint}:v${revision}`;
}

function cacheMaxAgeSeconds(value: string | null): number | null {
  if (!value) return null;
  const directive = value.split(",").map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith("max-age="));
  if (!directive) return null;
  const seconds = Number(directive.slice("max-age=".length).replace(/"/g, ""));
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSourceMetadata(
  state: EndpointState<unknown> | undefined,
  now: number,
): FieldViewSourceRecordMetadata | undefined {
  if (!state || state.status === "unknown") return undefined;
  if (state.status === "failed" || state.status === "unavailable") {
    return { status: state.status, retrieved_at: null };
  }
  const retrievedAt = state.lastFetchedAt ?? state.lastWebhookAt;
  if (retrievedAt === null) return { status: "failed", retrieved_at: null };
  const expired = state.expiresAt !== null && state.expiresAt < now;
  const status = state.status === "stale" || expired ? "stale" : "available";
  return {
    status,
    retrieved_at: new Date(retrievedAt).toISOString(),
    ...(state.lastFetchedAt !== null && state.etag !== null
      ? { validator: state.etag }
      : {}),
  };
}

function hasAcquiredValue(state: EndpointState<unknown> | undefined): boolean {
  return Boolean(state && (state.lastFetchedAt !== null || state.lastWebhookAt !== null));
}

export function eventResourceEndpoints(eventKey: string): string[] {
  return [
    TBA_ENDPOINTS.event(eventKey),
    TBA_ENDPOINTS.eventTeams(eventKey),
    TBA_ENDPOINTS.eventTeamStatuses(eventKey),
    TBA_ENDPOINTS.eventMatches(eventKey),
    TBA_ENDPOINTS.eventAlliances(eventKey),
    TBA_ENDPOINTS.eventOPRs(eventKey),
    TBA_ENDPOINTS.eventPredictions(eventKey),
    TBA_ENDPOINTS.eventRankings(eventKey),
    TBA_ENDPOINTS.eventAwards(eventKey),
    TBA_ENDPOINTS.eventMedia(eventKey),
    TBA_ENDPOINTS.eventDistrictPoints(eventKey),
    TBA_ENDPOINTS.eventAdvancementPoints(eventKey),
  ];
}

/**
 * One EventRuntime instance owns one event's provider endpoint state and
 * TBA polling schedule. Statbotics enrichment is one-shot and TBA-change-driven.
 * Network I/O always occurs outside storage transactions.
 */
export class EventRuntime {
  private readonly state: DurableObjectStateLike;
  private readonly storage: DurableObjectStateLike["storage"];
  private readonly api: TBAApiClient;
  private readonly statboticsApi: StatboticsApiClient;
  private readonly env: RuntimeEnvironment;
  private eventKey: string;
  private allowedEndpoints: Set<string>;

  constructor(state: DurableObjectStateLike, env: RuntimeEnvironment, eventKey?: string) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.api = new TBAApiClient({
      apiKey: env.TBA_API_KEY,
      ...(env.fetcher ? { fetch: env.fetcher } : {}),
    });
    this.statboticsApi = new StatboticsApiClient({
      ...(env.STATBOTICS_API_BASE_URL ? { baseUrl: env.STATBOTICS_API_BASE_URL } : {}),
      ...(env.fetcher ? { fetch: env.fetcher } : {}),
    });
    this.eventKey = eventKey ?? "";
    this.allowedEndpoints = new Set(this.eventKey ? eventResourceEndpoints(this.eventKey) : []);
  }

  private async bindEventKey(request: Request): Promise<boolean> {
    const requested = request.headers.get("X-FieldView-Event-Key");
    if (!requested || !/^[a-zA-Z0-9_-]+$/.test(requested)) return false;
    const stored = await this.storage.get<string>("event-key");
    if (stored && stored !== requested) return false;
    if (!stored) {
      await this.storage.transaction(async (transaction) => {
        const current = await transaction.get<string>("event-key");
        if (current && current !== requested) throw new Error("Durable Object event identity mismatch");
        if (!current) await transaction.put("event-key", requested);
      });
    }
    this.eventKey = requested;
    this.allowedEndpoints = new Set(eventResourceEndpoints(requested));
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Authorization") !== "Bearer " + this.env.RUNTIME_ADMIN_TOKEN) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!(await this.bindEventKey(request))) {
      return Response.json({ error: "Invalid or mismatched event identity" }, { status: 400 });
    }

    if (request.method === "POST" && url.pathname === "/schedule") {
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || !Array.isArray(body.endpoints) ||
          !body.endpoints.every((endpoint) => typeof endpoint === "string")) {
        return Response.json({ error: "Expected an endpoints array" }, { status: 400 });
      }
      const intervalMs = body.intervalMs;
      if (typeof intervalMs !== "number" || !Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
        return Response.json({ error: "intervalMs must be an integer of at least 1000" }, { status: 400 });
      }
      const endpoints = body.endpoints as string[];
      if (endpoints.some((endpoint) => !this.allowedEndpoints.has(endpoint))) {
        return Response.json({ error: "Endpoint is not part of this event" }, { status: 400 });
      }
      await this.schedulePolls(endpoints, intervalMs);
      return Response.json({ scheduled: endpoints.length, event_key: this.eventKey });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const rawPayload = await request.text();
      const webhookId = request.headers.get("X-FieldView-Webhook-Id");
      if (!webhookId || !/^[a-f0-9]{64}$/.test(webhookId)) {
        return Response.json({ error: "Missing webhook id" }, { status: 400 });
      }
      let payload: unknown;
      try { payload = JSON.parse(rawPayload); }
      catch { return Response.json({ error: "Invalid webhook JSON" }, { status: 400 }); }
      if (!isRecord(payload) || typeof payload.message_type !== "string" ||
          !isRecord(payload.message_data)) {
        return Response.json({ error: "Invalid TBA webhook payload" }, { status: 400 });
      }
      const messageEventKey = payload.message_data.event_key;
      if (messageEventKey !== this.eventKey) {
        return Response.json({ error: "Webhook event key mismatch" }, { status: 400 });
      }
      const accepted = await this.applyTbaWebhook(
        webhookId, payload.message_type, payload.message_data, rawPayload,
      );
      return Response.json({ accepted: true, duplicate: !accepted });
    }

    if (request.method === "GET" && url.pathname === "/stream") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return Response.json({ error: "WebSocket upgrade required" }, { status: 426 });
      if (!this.state.acceptWebSocket || !this.state.getWebSockets) return Response.json({ error: "WebSocket subscriptions are unavailable" }, { status: 501 });
      const pair = this.env.webSocketPairFactory ? this.env.webSocketPairFactory() : new (globalThis as typeof globalThis & { WebSocketPair: new () => { 0: WebSocket; 1: WebSocket } }).WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      const version = await this.storage.get<number>("snapshot-revision") ?? 0;
      const sinceParam = url.searchParams.get("since");
      const since = sinceParam !== null && /^\d+$/.test(sinceParam) ? Number(sinceParam) : null;
      pair[1].send(JSON.stringify({ type: "connected", event_key: this.eventKey, version, snapshot_required: since === null || !Number.isSafeInteger(since) || since !== version }));
      return this.env.webSocketResponseFactory ? this.env.webSocketResponseFactory(pair[0]) : new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit & { webSocket: WebSocket });
    }
    if (request.method === "GET" && url.pathname === "/snapshot") {
      const result = await this.buildEventSnapshot();
      return Response.json(result.snapshot, {
        headers: { "X-FieldView-Snapshot-Version": String(result.version) },
      });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const entries = await this.storage.list<EndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      return Response.json({
        event_key: this.eventKey,
        endpoints: Object.fromEntries(entries),
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private async buildEventSnapshot(): Promise<{ version: number; snapshot: ReturnType<typeof normalizeFieldViewEventSnapshot> }> {
    const endpoints = eventResourceEndpoints(this.eventKey);
    const eventEndpoint = endpoints[0];
    const teamsEndpoint = endpoints[1];
    const statusesEndpoint = endpoints[2];
    const matchesEndpoint = endpoints[3];
    const alliancesEndpoint = endpoints[4];
    const oprsEndpoint = endpoints[5];
    const predictionsEndpoint = endpoints[6];
    const statboticsMatchesEndpoint = STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0);
    // Read the aggregate's endpoint state and version from one transaction so
    // a snapshot can never combine data from opposite sides of a mutation.
    const state = await this.storage.transaction(async (transaction) => ({
      version: await transaction.get<number>("snapshot-revision") ?? 0,
      event: await transaction.get<EndpointState<unknown>>(endpointStorageKey(eventEndpoint)),
      teams: await transaction.get<EndpointState<unknown>>(endpointStorageKey(teamsEndpoint)),
      statuses: await transaction.get<EndpointState<unknown>>(endpointStorageKey(statusesEndpoint)),
      matches: await transaction.get<EndpointState<unknown>>(endpointStorageKey(matchesEndpoint)),
      alliances: await transaction.get<EndpointState<unknown>>(endpointStorageKey(alliancesEndpoint)),
      oprs: await transaction.get<EndpointState<unknown>>(endpointStorageKey(oprsEndpoint)),
      predictions: await transaction.get<EndpointState<unknown>>(endpointStorageKey(predictionsEndpoint)),
      statboticsMatches: await transaction.get<EndpointState<unknown>>(endpointStorageKey(statboticsMatchesEndpoint)),
    }));
    const {
      event: eventState, teams: teamsState, statuses: statusesState,
      matches: matchesState, alliances: alliancesState, oprs: oprsState,
      predictions: predictionsState, statboticsMatches: statboticsMatchesState,
    } = state;
    const now = Date.now();
    const eventSource = toSourceMetadata(eventState, now);
    const teamsSource = toSourceMetadata(teamsState, now);
    const statusSource = toSourceMetadata(statusesState, now);
    const matchesSource = toSourceMetadata(matchesState, now);
    const alliancesSource = toSourceMetadata(alliancesState, now);
    const oprsSource = toSourceMetadata(oprsState, now);
    const predictionsSource = toSourceMetadata(predictionsState, now);
    const statboticsMatchesSource = toSourceMetadata(statboticsMatchesState, now);

    return {
      version: state.version,
      snapshot: normalizeFieldViewEventSnapshot({
        event_key: this.eventKey as EventKey,
        ...(hasAcquiredValue(eventState) ? { tba_event: eventState!.data as TBAEvent | null } : {}),
        ...(hasAcquiredValue(teamsState) ? { tba_teams: teamsState!.data as TBATeam[] | null } : {}),
        ...(hasAcquiredValue(statusesState)
          ? { tba_team_statuses: statusesState!.data as TBAEventTeamStatuses | null }
          : {}),
        ...(hasAcquiredValue(matchesState) ? { tba_matches: matchesState!.data as TBAMatch[] | null } : {}),
        ...(hasAcquiredValue(alliancesState)
          ? { tba_playoff_alliances: alliancesState!.data as TBAEliminationAlliance[] | null }
          : {}),
        ...(hasAcquiredValue(oprsState) ? { tba_event_oprs: oprsState!.data as TBAEventOPRs | null } : {}),
        ...(hasAcquiredValue(predictionsState)
          ? { tba_event_predictions: predictionsState!.data as TBAEventPredictions | null }
          : {}),
        ...(hasAcquiredValue(statboticsMatchesState)
          ? { statbotics_matches: statboticsMatchesState!.data as StatboticsMatch[] | null }
          : {}),
        sources: {
          event: eventSource ? { tba_event: eventSource } : {},
          teams: teamsSource ? { tba_teams: teamsSource } : {},
          event_teams: {
            ...(statusSource ? { tba_team_event_status: statusSource } : {}),
            ...(oprsSource ? { tba_event_oprs: oprsSource } : {}),
          },
          matches: {
            ...(matchesSource ? { tba_match: matchesSource } : {}),
            ...(predictionsSource ? { tba_event_predictions: predictionsSource } : {}),
            ...(oprsSource ? { tba_event_oprs: oprsSource } : {}),
            ...(statusSource ? { tba_team_event_status: statusSource } : {}),
            ...(alliancesSource ? { tba_playoff_alliances: alliancesSource } : {}),
            ...(statboticsMatchesSource ? { statbotics_match: statboticsMatchesSource } : {}),
          },
          playoff_alliances: alliancesSource
            ? { tba_playoff_alliances: alliancesSource }
            : {},
        },
      }),
    };
  }

  async schedulePolls(endpoints: string[], intervalMs: number, now = Date.now()): Promise<void> {
    if (endpoints.some((endpoint) => !this.allowedEndpoints.has(endpoint))) {
      throw new Error("Only TBA event endpoints can be scheduled for recurring polling");
    }
    await this.storage.transaction(async (transaction) => {
      for (const endpoint of endpoints) {
        const key = taskStorageKey(endpoint);
        const previous = await transaction.get<PollTask>(key);
        const task: PollTask = {
          endpoint,
          dueAt: now,
          intervalMs,
          generation: (previous?.generation ?? 0) + 1,
          attempts: 0,
          retryOnFailure: true,
        };
        await transaction.put(key, task);
      }
      await this.rearm(transaction);
    });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    // Reserve due work before network I/O. Retriable TBA work keeps a durable
    // retry deadline; at-most-once Statbotics work is removed before its fetch.
    const dueTasks = await this.storage.transaction(async (transaction) => {
      const tasks = await transaction.list<PollTask>({ prefix: TASK_PREFIX });
      const due = [...tasks.values()].filter((task) => task.dueAt <= now);
      for (const task of due) {
        if (task.retryOnFailure === false) {
          // One-shot enrichment is at-most-once: remove it before I/O so a
          // provider failure or runtime interruption cannot create polling.
          await transaction.delete(taskStorageKey(task.endpoint));
        } else {
          await transaction.put(taskStorageKey(task.endpoint), {
            ...task,
            dueAt: now + this.retryDelay(task),
            attempts: task.attempts + 1,
          });
        }
      }
      await this.rearm(transaction);
      return due;
    });

    for (const task of dueTasks) {
      const succeeded = await this.pollEndpoint(task.endpoint);
      if (task.retryOnFailure === false) continue;
      await this.storage.transaction(async (transaction) => {
        const key = taskStorageKey(task.endpoint);
        const current = await transaction.get<PollTask>(key);
        // An administrator may have replaced this task while its poll ran.
        if (!current || current.generation !== task.generation) return;
        const attempts = succeeded ? 0 : current.attempts;
        const exhausted = current.maxAttempts !== undefined && attempts >= current.maxAttempts;
        if (current.intervalMs === null && (succeeded || exhausted)) {
          await transaction.delete(key);
        } else {
          await transaction.put(key, {
            ...current,
            attempts,
            dueAt: Date.now() + (succeeded ? current.intervalMs! : this.retryDelay(current)),
          });
        }
        await this.rearm(transaction);
      });
    }
  }

  private retryDelay(task: PollTask): number {
    const baseDelay = task.maxAttempts !== undefined ? 30_000 : 2_000;
    return Math.min(5 * 60_000, baseDelay * (2 ** Math.min(Math.max(0, task.attempts - 1), 7)));
  }

  private async rearm(transaction: DurableObjectTransactionLike): Promise<void> {
    const tasks = await transaction.list<PollTask>({ prefix: TASK_PREFIX });
    const nextDue = [...tasks.values()].reduce<number | null>(
      (next, task) => next === null || task.dueAt < next ? task.dueAt : next,
      null,
    );
    if (nextDue === null) await transaction.deleteAlarm();
    else await transaction.setAlarm(nextDue);
  }

  private async pollEndpoint(endpoint: string): Promise<boolean> {
    const isStatboticsEndpoint = endpoint === STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0);
    const stored = await this.storage.get<EndpointState<unknown>>(endpointStorageKey(endpoint));
    const initial = stored ?? createEndpointState<unknown>(endpoint);
    const requestSnapshot = createPollRequestSnapshot(initial);
    const headers = new Headers();
    if (requestSnapshot.ifNoneMatch) headers.set("If-None-Match", requestSnapshot.ifNoneMatch);

    let responseState:
      | { status: "modified"; data: unknown; etag: string | null; expiresAt: number | null }
      | { status: "not-modified"; expiresAt: number | null }
      | { status: "failed" };

    try {
      const response = isStatboticsEndpoint
        ? await this.statboticsApi.request(endpoint, { headers })
        : await this.api.request(endpoint, { headers });
      const maxAge = cacheMaxAgeSeconds(response.headers.get("Cache-Control"));
      const expiresAt = maxAge === null ? null : Date.now() + maxAge * 1000;

      if (response.status === 304) {
        responseState = {
          status: "not-modified",
          expiresAt: expiresAt ?? initial.expiresAt,
        };
      } else if (!response.ok) {
        responseState = { status: "failed" };
      } else {
        responseState = {
          status: "modified",
          data: await response.json(),
          etag: response.headers.get("ETag"),
          expiresAt,
        };
      }
    } catch {
      responseState = { status: "failed" };
    }

    const result = await this.storage.transaction(async (transaction) => {
      const key = endpointStorageKey(endpoint);
      const latest = await transaction.get<EndpointState<unknown>>(key) ?? initial;
      const now = Date.now();
      const next = applyPollResponse(
        latest,
        requestSnapshot,
        responseState,
        now,
        (current, fetched) => endpoint === STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0)
          ? fetched
          : reconcilePolledEndpoint(endpoint, current, fetched),
      );
      await transaction.put(key, next);
      if (next.revision !== latest.revision) {
        const snapshotRevision = await transaction.get<number>("snapshot-revision") ?? 0;
        await transaction.put("snapshot-revision", snapshotRevision + 1);
      }

      // Preserve each accepted upstream 200 payload as an immutable source
      // version. The current endpoint state may also contain webhook patches;
      // source records retain exactly what TBA returned.
      const sourceVersion = createProviderSourceVersion(latest, next, responseState, now);
      if (sourceVersion) {
        await transaction.put(
          sourceStorageKey(endpoint, sourceVersion.validatorRevision),
          sourceVersion,
        );
      }
      const representationChanged = sourceVersion !== null &&
        JSON.stringify(latest.providerData) !== JSON.stringify(
          responseState.status === "modified" ? responseState.data : undefined,
        );
      const snapshotVersion = await transaction.get<number>("snapshot-revision") ?? 0;
      return { status: next.status, representationChanged, snapshotChanged: next.revision !== latest.revision, snapshotVersion };
    });

    if (result.snapshotChanged) this.publishSnapshotRevision(result.snapshotVersion);

    if (result.representationChanged && this.isStatboticsTriggerEndpoint(endpoint)) {
      await this.scheduleStatboticsRefresh(Date.now());
    }

    // A 304 without a retained representation is not a successful refresh.
    // A Statbotics 304 means its representation has not caught up to the TBA
    // change that triggered this bounded refresh. Retry without discarding data.
    return responseState.status !== "failed" && result.status !== "failed" &&
      !(isStatboticsEndpoint && responseState.status === "not-modified");
  }

  private isStatboticsTriggerEndpoint(endpoint: string): boolean {
    return [
      TBA_ENDPOINTS.event(this.eventKey),
      TBA_ENDPOINTS.eventTeams(this.eventKey),
      TBA_ENDPOINTS.eventTeamStatuses(this.eventKey),
      TBA_ENDPOINTS.eventMatches(this.eventKey),
    ].includes(endpoint);
  }

  private async scheduleStatboticsRefresh(now: number): Promise<void> {
    const endpoint = STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0);
    const configuredDelay = this.env.STATBOTICS_REFRESH_DELAY_MS;
    const delayMs = configuredDelay === undefined ? 5 * 60_000 : Number(configuredDelay);
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      throw new Error("STATBOTICS_REFRESH_DELAY_MS must be a non-negative integer");
    }
    await this.storage.transaction(async (transaction) => {
      const key = taskStorageKey(endpoint);
      const previous = await transaction.get<PollTask>(key);
      await transaction.put(key, {
        endpoint,
        dueAt: now + delayMs,
        intervalMs: null,
        generation: (previous?.generation ?? 0) + 1,
        attempts: 0,
        retryOnFailure: true,
        maxAttempts: 4,
      });
      await this.rearm(transaction);
    });
  }

  private async scheduleImmediatePoll(
    transaction: DurableObjectTransactionLike,
    endpoint: string,
    now: number,
  ): Promise<void> {
    const key = taskStorageKey(endpoint);
    const previous = await transaction.get<PollTask>(key);
    await transaction.put(key, {
      endpoint,
      dueAt: now,
      intervalMs: previous?.intervalMs ?? null,
      generation: (previous?.generation ?? 0) + 1,
      attempts: 0,
      retryOnFailure: true,
    });
  }

  private async applyTbaWebhook(
    webhookId: string,
    messageType: string,
    messageData: Record<string, unknown>,
    rawPayload: string,
  ): Promise<boolean> {
    const eventKey = this.eventKey;
    const matchesEndpoint = TBA_ENDPOINTS.eventMatches(eventKey);
    const eventEndpoint = TBA_ENDPOINTS.event(eventKey);
    const now = Date.now();

    const result = await this.storage.transaction(async (transaction) => {
      const webhookKey = "webhook:" + webhookId;
      if (await transaction.get(webhookKey) !== undefined) return { accepted: false, snapshotVersion: null as number | null };
      await transaction.put(webhookKey, { receivedAt: now, messageType, rawPayload });

      if (messageType === "match_score" || messageType === "match_video") {
        const match = messageData.match;
        if (isRecord(match) && typeof match.key === "string" && match.event_key === eventKey) {
          const key = endpointStorageKey(matchesEndpoint);
          const current = await transaction.get<EndpointState<unknown>>(key) ??
            createEndpointState<unknown>(matchesEndpoint);
          const next = applyWebhookUpdate(
            current, match, now,
            (latest, update) => reconcileWebhookEndpoint(matchesEndpoint, latest, update),
          );
          await transaction.put(key, next);
          const snapshotRevision = await transaction.get<number>("snapshot-revision") ?? 0;
          await transaction.put("snapshot-revision", snapshotRevision + 1);
        }
        await this.scheduleImmediatePoll(transaction, matchesEndpoint, now);
      } else if (
        messageType === "upcoming_match" ||
        messageType === "schedule_updated" ||
        messageType === "starting_comp_level"
      ) {
        await this.scheduleImmediatePoll(transaction, matchesEndpoint, now);
      } else if (messageType === "alliance_selection") {
        await this.scheduleImmediatePoll(transaction, eventEndpoint, now);
        await this.scheduleImmediatePoll(
          transaction, TBA_ENDPOINTS.eventAlliances(eventKey), now,
        );
        await this.scheduleImmediatePoll(
          transaction, TBA_ENDPOINTS.eventTeamStatuses(eventKey), now,
        );
      } else if (messageType === "awards_posted") {
        await this.scheduleImmediatePoll(
          transaction, TBA_ENDPOINTS.eventAwards(eventKey), now,
        );
      }

      await this.rearm(transaction);
      const snapshotVersion = await transaction.get<number>("snapshot-revision") ?? 0;
      return { accepted: true, snapshotVersion: messageType === "match_score" || messageType === "match_video" ? snapshotVersion : null };
    });
    if (result.snapshotVersion !== null) this.publishSnapshotRevision(result.snapshotVersion);
    return result.accepted;
  }

  private publishSnapshotRevision(version: number): void {
    const message = JSON.stringify({ type: "snapshot.changed", event_key: this.eventKey, version });
    for (const socket of this.state.getWebSockets?.() ?? []) {
      try { socket.send(message); }
      catch { try { socket.close(1011, "Subscription delivery failed"); } catch { /* already closed */ } }
    }
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") { try { socket.send("pong"); } catch { /* already closed */ } return; }
    try { socket.close(1008, "Unsupported subscription message"); } catch { /* already closed */ }
  }

}
