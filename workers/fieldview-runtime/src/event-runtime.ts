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
import type { TBAAward, TBAEliminationAlliance, TBAEvent, TBAEventAdvancementPoints, TBAEventOPRs, TBAEventPredictions, TBAEventRanking, TBAEventTeamStatuses, TBAMatch, TBATeam } from "../../../packages/providers/tba/src/types.ts";
import type { StatboticsMatch } from "../../../packages/providers/statbotics/src/types.ts";
import type { EventKey } from "../../../packages/domain/src/ids.ts";
import type { FieldViewSourceRecordMetadata } from "../../../packages/domain/src/source-metadata.ts";
import { normalizeFieldViewEventState } from "../../../packages/domain/src/normalization/event-state.ts";

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
  /** One-shot REST reconciliation after a webhook's immediate refresh. */
  authoritativeRefetchAt?: number;
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
    const adminAuthorized = Boolean(this.env.RUNTIME_ADMIN_TOKEN) &&
      request.headers.get("Authorization") === "Bearer " + this.env.RUNTIME_ADMIN_TOKEN;
    const publicRead = request.method === "GET" &&
      (url.pathname === "/snapshot" || url.pathname === "/stream");
    if (!adminAuthorized && !publicRead) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!(await this.bindEventKey(request))) {
      return Response.json({ error: "Invalid or mismatched event identity" }, { status: 400 });
    }

    if (request.method === "POST" && url.pathname === "/subscriptions") {
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || (body.action !== "subscribe" && body.action !== "unsubscribe") ||
          (body.generation !== undefined &&
            (!Number.isSafeInteger(body.generation) || (body.generation as number) < 1))) {
        return Response.json({ error: "Expected subscribe or unsubscribe action and an optional positive generation" }, { status: 400 });
      }
      if (typeof body.generation === "number") {
        const currentGeneration = await this.storage.get<number>("multiplexer:registration-generation") ?? 0;
        if (body.generation <= currentGeneration) {
          return Response.json({
            registered: await this.storage.get<boolean>("multiplexer:shared") === true,
            event_key: this.eventKey,
            generation: currentGeneration,
            stale: true,
          });
        }
        await this.storage.put("multiplexer:registration-generation", body.generation);
      }
      const registered = body.action === "subscribe";
      await this.storage.put("multiplexer:shared", registered);
      return Response.json({
        registered,
        event_key: this.eventKey,
        ...(typeof body.generation === "number" ? { generation: body.generation } : {}),
      });
    }

    if (request.method === "POST" && url.pathname === "/lifecycle") {
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || !["upcoming", "active", "completed", "expired"].includes(String(body.lifecycle))) {
        return Response.json({ error: "Invalid event lifecycle" }, { status: 400 });
      }
      const upcomingIntervalMs = body.upcomingIntervalMs;
      const activeIntervalMs = body.activeIntervalMs;
      const completedUntil = body.completedUntil;
      if (![upcomingIntervalMs, activeIntervalMs].every((value) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 1_000) ||
        (completedUntil !== undefined && (typeof completedUntil !== "number" || !Number.isSafeInteger(completedUntil)))) {
        return Response.json({ error: "Invalid lifecycle polling configuration" }, { status: 400 });
      }
      const liveEndpoints = [
        TBA_ENDPOINTS.eventTeamStatuses(this.eventKey),
        TBA_ENDPOINTS.eventMatches(this.eventKey),
        TBA_ENDPOINTS.eventAlliances(this.eventKey),
        TBA_ENDPOINTS.eventOPRs(this.eventKey),
        TBA_ENDPOINTS.eventPredictions(this.eventKey),
      ];
      const lifecycle = body.lifecycle;
      if (lifecycle === "expired") {
        await this.cancelRecurringPolls(true);
        return Response.json({ lifecycle, scheduled: 0, event_key: this.eventKey });
      }
      if (lifecycle === "upcoming") {
        await this.schedulePolls([...this.allowedEndpoints], upcomingIntervalMs as number);
        await this.storage.transaction(async (transaction) => {
          await transaction.delete("lifecycle:completed-until");
          await this.rearm(transaction);
        });
      } else {
        const metadataEndpoints = [...this.allowedEndpoints].filter((endpoint) => !liveEndpoints.includes(endpoint));
        await this.schedulePolls(metadataEndpoints, upcomingIntervalMs as number);
        await this.schedulePolls(liveEndpoints, activeIntervalMs as number);
        await this.storage.transaction(async (transaction) => {
          if (lifecycle === "completed" && typeof completedUntil === "number") {
            await transaction.put("lifecycle:completed-until", completedUntil);
          } else {
            await transaction.delete("lifecycle:completed-until");
          }
          await this.rearm(transaction);
        });
      }
      // Lifecycle activation is also the initial-ingestion trigger. Do not
      // leave a newly scheduled event waiting for its next polling interval.
      await this.alarm();
      return Response.json({ lifecycle, attempted: true, event_key: this.eventKey });
    }

    if (request.method === "POST" && url.pathname === "/statbotics-refresh") {
      const endpoint = STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0);
      const scheduledAt = Date.now();
      await this.scheduleStatboticsRefresh(scheduledAt);
      const configuredDelay = this.env.STATBOTICS_REFRESH_DELAY_MS;
      const delayMs = configuredDelay === undefined ? 5 * 60_000 : Number(configuredDelay);
      return Response.json({
        scheduled: true,
        event_key: this.eventKey,
        endpoint,
        due_at: scheduledAt + delayMs,
        delay_ms: delayMs,
      });
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
      await this.alarm();
      return Response.json({ scheduled: endpoints.length, attempted: true, event_key: this.eventKey });
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
      // A public read creates demand for missing or stale canonical resources.
      // Scheduling only persists the work and arms the DO alarm; provider I/O
      // runs asynchronously after this request returns.
      await this.scheduleDemandIngestion();
      const result = await this.buildEventState();
      return Response.json(result.state, {
        headers: { "X-FieldView-Snapshot-Version": String(result.version) },
      });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const entries = await this.storage.list<EndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      const tasks = await this.storage.list<PollTask>({ prefix: TASK_PREFIX });
      return Response.json({
        event_key: this.eventKey,
        lifecycle: {
          completed_until: await this.storage.get<number>("lifecycle:completed-until") ?? null,
        },
        polling: [...tasks.values()].map((task) => ({
          endpoint: task.endpoint,
          due_at: task.dueAt,
          interval_ms: task.intervalMs,
          generation: task.generation,
          attempts: task.attempts,
          retry_on_failure: task.retryOnFailure,
          ...(task.authoritativeRefetchAt === undefined
            ? {}
            : { authoritative_refetch_at: task.authoritativeRefetchAt }),
        })).sort((left, right) => left.endpoint.localeCompare(right.endpoint)),
        endpoints: Object.fromEntries(entries),
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private async buildEventState(): Promise<{ version: number; state: ReturnType<typeof normalizeFieldViewEventState> }> {
    const endpoints = eventResourceEndpoints(this.eventKey);
    const eventEndpoint = endpoints[0];
    const teamsEndpoint = endpoints[1];
    const statusesEndpoint = endpoints[2];
    const matchesEndpoint = endpoints[3];
    const alliancesEndpoint = endpoints[4];
    const oprsEndpoint = endpoints[5];
    const predictionsEndpoint = endpoints[6];
    const rankingsEndpoint = TBA_ENDPOINTS.eventRankings(this.eventKey);
    const awardsEndpoint = TBA_ENDPOINTS.eventAwards(this.eventKey);
    const advancementPointsEndpoint = TBA_ENDPOINTS.eventAdvancementPoints(this.eventKey);
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
      rankings: await transaction.get<EndpointState<unknown>>(endpointStorageKey(rankingsEndpoint)),
      awards: await transaction.get<EndpointState<unknown>>(endpointStorageKey(awardsEndpoint)),
      advancementPoints: await transaction.get<EndpointState<unknown>>(endpointStorageKey(advancementPointsEndpoint)),
      statboticsMatches: await transaction.get<EndpointState<unknown>>(endpointStorageKey(statboticsMatchesEndpoint)),
    }));
    const {
      event: eventState, teams: teamsState, statuses: statusesState,
      matches: matchesState, alliances: alliancesState, oprs: oprsState,
      predictions: predictionsState, rankings: rankingsState, awards: awardsState,
      advancementPoints: advancementPointsState, statboticsMatches: statboticsMatchesState,
    } = state;
    const now = Date.now();
    const eventSource = toSourceMetadata(eventState, now);
    const teamsSource = toSourceMetadata(teamsState, now);
    const statusSource = toSourceMetadata(statusesState, now);
    const matchesSource = toSourceMetadata(matchesState, now);
    const alliancesSource = toSourceMetadata(alliancesState, now);
    const oprsSource = toSourceMetadata(oprsState, now);
    const predictionsSource = toSourceMetadata(predictionsState, now);
    const rankingsSource = toSourceMetadata(rankingsState, now);
    const awardsSource = toSourceMetadata(awardsState, now);
    const advancementPointsSource = toSourceMetadata(advancementPointsState, now);
    const statboticsMatchesSource = toSourceMetadata(statboticsMatchesState, now);

    return {
      version: state.version,
      state: normalizeFieldViewEventState({
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
        ...(hasAcquiredValue(rankingsState)
          ? { tba_event_rankings: rankingsState!.data as TBAEventRanking | null }
          : {}),
        ...(hasAcquiredValue(awardsState)
          ? { tba_event_awards: awardsState!.data as TBAAward[] | null }
          : {}),
        ...(hasAcquiredValue(advancementPointsState)
          ? { tba_event_advancement_points: advancementPointsState!.data as TBAEventAdvancementPoints | null }
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
          rankings: rankingsSource ? { tba_event_rankings: rankingsSource } : {},
          awards: awardsSource ? { tba_event_awards: awardsSource } : {},
          advancement_points: advancementPointsSource
            ? { tba_event_advancement_points: advancementPointsSource }
            : {},
        },
      }),
    };
  }

  private async scheduleDemandIngestion(now = Date.now()): Promise<void> {
    const defaultIntervalMs = 24 * 60 * 60_000;
    await this.storage.transaction(async (transaction) => {
      for (const endpoint of this.allowedEndpoints) {
        const state = await transaction.get<EndpointState<unknown>>(endpointStorageKey(endpoint));
        const needsIngestion = !state || state.status === "unknown" || state.status === "stale" ||
          (state.expiresAt !== null && state.expiresAt < now);
        if (!needsIngestion) continue;

        const key = taskStorageKey(endpoint);
        const previous = await transaction.get<PollTask>(key);
        const task: PollTask = previous
          ? { ...previous, dueAt: Math.min(previous.dueAt, now) }
          : {
              endpoint,
              dueAt: now,
              intervalMs: defaultIntervalMs,
              generation: 1,
              attempts: 0,
              retryOnFailure: true,
            };
        await transaction.put(key, task);
      }
      await this.rearm(transaction);
    });
  }

  async schedulePolls(endpoints: string[], intervalMs: number, now = Date.now()): Promise<void> {
    if (endpoints.some((endpoint) => !this.allowedEndpoints.has(endpoint))) {
      throw new Error("Only TBA event endpoints can be scheduled for recurring polling");
    }
    await this.storage.transaction(async (transaction) => {
      for (const endpoint of endpoints) {
        const key = taskStorageKey(endpoint);
        const previous = await transaction.get<PollTask>(key);
        const unchanged = previous?.retryOnFailure === true && previous.intervalMs === intervalMs;
        const task: PollTask = {
          endpoint,
          dueAt: unchanged ? previous.dueAt : now,
          intervalMs,
          generation: unchanged ? previous.generation : (previous?.generation ?? 0) + 1,
          attempts: unchanged ? previous.attempts : 0,
          retryOnFailure: true,
          ...(previous?.authoritativeRefetchAt === undefined
            ? {}
            : { authoritativeRefetchAt: previous.authoritativeRefetchAt }),
        };
        await transaction.put(key, task);
      }
      await this.rearm(transaction);
    });
  }

  private async restoreEventIdentity(): Promise<boolean> {
    const storedEventKey = await this.storage.get<string>("event-key");
    const eventKey = storedEventKey ?? this.eventKey;
    if (!eventKey || !/^[a-zA-Z0-9_-]+$/.test(eventKey)) return false;
    if (this.eventKey && this.eventKey !== eventKey) {
      throw new Error("Durable Object event identity mismatch");
    }
    this.eventKey = eventKey;
    this.allowedEndpoints = new Set(eventResourceEndpoints(eventKey));
    return true;
  }

  async alarm(): Promise<void> {
    // Durable Objects can be reconstructed between requests and alarms. Never
    // route provider work using constructor-only in-memory identity.
    const hasEventIdentity = await this.restoreEventIdentity();
    const now = Date.now();
    const completedUntil = await this.storage.get<number>("lifecycle:completed-until");
    if (completedUntil !== undefined && now >= completedUntil) {
      await this.cancelRecurringPolls(true);
    }
    // Reserve due work before network I/O. Retriable TBA work keeps a durable
    // retry deadline; at-most-once Statbotics work is removed before its fetch.
    const dueTasks = await this.storage.transaction(async (transaction) => {
      const tasks = await transaction.list<PollTask>({ prefix: TASK_PREFIX });
      const due = [...tasks.values()].filter((task) => task.dueAt <= now);
      if (due.length > 0 && !hasEventIdentity) {
        throw new Error("Cannot execute event alarm without persisted event identity");
      }
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
        const completedAt = Date.now();
        const attempts = succeeded ? 0 : current.attempts;
        const exhausted = current.maxAttempts !== undefined && attempts >= current.maxAttempts;
        if (succeeded && current.authoritativeRefetchAt !== undefined &&
            completedAt >= current.authoritativeRefetchAt) {
          const { authoritativeRefetchAt: _completedRefetch, ...recurringTask } = current;
          if (current.intervalMs === null) {
            await transaction.delete(key);
          } else {
            await transaction.put(key, {
              ...recurringTask,
              attempts: 0,
              dueAt: completedAt + current.intervalMs,
            });
          }
        } else if (succeeded && current.authoritativeRefetchAt !== undefined) {
          await transaction.put(key, {
            ...current,
            attempts: 0,
            dueAt: current.authoritativeRefetchAt,
          });
        } else if (current.intervalMs === null && (succeeded || exhausted) &&
            current.authoritativeRefetchAt === undefined) {
          await transaction.delete(key);
        } else {
          await transaction.put(key, {
            ...current,
            attempts,
            dueAt: completedAt + (succeeded ? current.intervalMs! : this.retryDelay(current)),
          });
        }
        await this.rearm(transaction);
      });
    }
  }

  private async cancelRecurringPolls(clearCompletedUntil = false): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const tasks = await transaction.list<PollTask>({ prefix: TASK_PREFIX });
      for (const [key, task] of tasks) {
        if (task.retryOnFailure !== false) await transaction.delete(key);
      }
      if (clearCompletedUntil) await transaction.delete("lifecycle:completed-until");
      await this.rearm(transaction);
    });
  }

  private retryDelay(task: PollTask): number {
    const baseDelay = task.maxAttempts !== undefined ? 30_000 : 2_000;
    return Math.min(5 * 60_000, baseDelay * (2 ** Math.min(Math.max(0, task.attempts - 1), 7)));
  }

  private async rearm(transaction: DurableObjectTransactionLike): Promise<void> {
    const tasks = await transaction.list<PollTask>({ prefix: TASK_PREFIX });
    const completedUntil = await transaction.get<number>("lifecycle:completed-until");
    const nextDue = [...tasks.values()].reduce<number | null>(
      (next, task) => next === null || task.dueAt < next ? task.dueAt : next,
      completedUntil ?? null,
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
      | { status: "failed"; reason: string };

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
        responseState = {
          status: "failed",
          reason: `HTTP ${response.status}${response.statusText ? " " + response.statusText : ""} from ${response.url ? (() => { const url = new URL(response.url); return url.origin + url.pathname; })() : "unknown URL"}`,
        };
      } else {
        responseState = {
          status: "modified",
          data: await response.json(),
          etag: response.headers.get("ETag"),
          expiresAt,
        };
      }
    } catch (error) {
      // Keep a short, secret-free diagnostic for admin inspection. Never store
      // response bodies, request headers, or provider credentials.
      const detail = error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
      responseState = {
        status: "failed",
        reason: detail.slice(0, 300) || "Unknown fetch or response error",
      };
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
      const nextWithDiagnostic = {
        ...next,
        lastError: responseState.status === "failed" ? responseState.reason : null,
      };
      await transaction.put(key, nextWithDiagnostic);
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

    if (result.snapshotChanged) await this.publishSnapshotRevision(result.snapshotVersion);

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

  private authoritativeRefetchDelayMs(): number {
    const configured = this.env.TBA_AUTHORITATIVE_REFETCH_DELAY_MS;
    const delay = configured === undefined ? 65_000 : Number(configured);
    if (!Number.isSafeInteger(delay) || delay < 0) {
      throw new Error("TBA_AUTHORITATIVE_REFETCH_DELAY_MS must be a non-negative integer");
    }
    return delay;
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
      authoritativeRefetchAt: now + this.authoritativeRefetchDelayMs(),
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
    if (result.snapshotVersion !== null) await this.publishSnapshotRevision(result.snapshotVersion);
    return result.accepted;
  }

  private async publishSnapshotRevision(version: number): Promise<void> {
    // Keep the legacy direct stream available during migration, while the
    // shared multiplexer becomes the browser integration path.
    const message = JSON.stringify({ type: "snapshot.changed", event_key: this.eventKey, version });
    for (const socket of this.state.getWebSockets?.() ?? []) {
      try { socket.send(message); }
      catch { try { socket.close(1011, "Subscription delivery failed"); } catch { /* already closed */ } }
    }

    if (await this.storage.get<boolean>("multiplexer:shared") !== true || !this.env.MULTIPLEXER) return;
    const multiplexer = this.env.MULTIPLEXER.get(this.env.MULTIPLEXER.idFromName("shared"));
    await multiplexer.fetch(new Request("https://fieldview-multiplexer/internal/notify", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ topic: "event-state", event_key: this.eventKey, version }),
    })).catch(() => undefined);
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") { try { socket.send("pong"); } catch { /* already closed */ } return; }
    try { socket.close(1008, "Unsupported subscription message"); } catch { /* already closed */ }
  }

}
