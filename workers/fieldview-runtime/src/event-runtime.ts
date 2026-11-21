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
import type { FieldViewAnalyticsInputRecord } from "../../../packages/domain/src/analytics.ts";
import { normalizeFieldViewEventState } from "../../../packages/domain/src/normalization/event-state.ts";
import { calculateCanonicalMatchAnalytics } from "../../../packages/analytics/src/canonical-match-analytics.ts";
import {
  mergeAnalyticsInvalidations,
  planAnalyticsInvalidation,
  type AnalyticsInvalidation,
  type AnalyticsSourceKey,
} from "../../../packages/analytics/src/invalidation.ts";
import { buildCanonicalSeasonCohort } from "../../../packages/analytics/src/canonical-season-cohort.ts";
import type { FieldViewTeamState, FieldViewTeamEventState } from "../../../packages/domain/src/team.ts";

interface ManualPollRequest { endpoint: string; dueAt: number; attempts: number; }

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
const MANUAL_QUEUE_KEY = "manual:poll-queue";
const ENDPOINT_PREFIX = "endpoint:";
const SOURCE_PREFIX = "source:";
const ANALYTICS_DUE_KEY = "analytics:due-at";
const ANALYTICS_ENABLED_KEY = "analytics:enabled";
const ANALYTICS_PUBLICATION_KEY = "analytics:publication";
const EVENT_STATE_PUBLICATION_KEY = "event-state:publication";
const ANALYTICS_REVISION_KEY = "analytics:revision";
const ANALYTICS_COHORT_RETRY_KEY = "analytics:cohort-retries";
const ANALYTICS_ALLOW_PARTIAL_COHORT_KEY = "analytics:allow-partial-cohort";
const ANALYTICS_SEASON_TEAM_REVISION_KEY = "analytics:season-team-revision";
const ANALYTICS_INVALIDATION_KEY = "analytics:invalidation";
const ANALYTICS_COHORT_RETRY_DELAY_MS = 5 * 60_000;
const ANALYTICS_COHORT_MAX_RETRIES = 12;

interface EventStatePublication {
  sourceRevision: number;
  snapshotVersion: number;
  generatedAt: number;
  status: "complete" | "partial" | "failed";
  state: ReturnType<typeof normalizeFieldViewEventState>;
}

interface AnalyticsPublication {
  sourceRevision: number;
  seasonTeamRevision?: number;
  calculatedAt: number;
  analyticsRevision?: number;
  matches: Array<{ key: string; analysis?: unknown; flags?: unknown }>;
  eventAnalytics?: unknown;
}

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

function analyticsSourceForEndpoint(endpoint: string, eventKey: string): AnalyticsSourceKey | null {
  if (endpoint === TBA_ENDPOINTS.event(eventKey)) return "tba-event";
  if (endpoint === TBA_ENDPOINTS.eventTeams(eventKey)) return "tba-event-teams";
  if (endpoint === TBA_ENDPOINTS.eventTeamStatuses(eventKey)) return "tba-team-event-statuses";
  if (endpoint === TBA_ENDPOINTS.eventMatches(eventKey)) return "tba-event-matches";
  if (endpoint === TBA_ENDPOINTS.eventAlliances(eventKey)) return "tba-event-alliances";
  if (endpoint === TBA_ENDPOINTS.eventOPRs(eventKey)) return "tba-event-oprs";
  if (endpoint === TBA_ENDPOINTS.eventPredictions(eventKey)) return "tba-event-predictions";
  if (endpoint === STATBOTICS_ENDPOINTS.matches({ event: eventKey }, 1000, 0)) return "statbotics-event-matches";
  return null;
}

function matchAnalyticsProjection(value: unknown, source: AnalyticsSourceKey): unknown {
  if (source === "statbotics-event-matches" || !isRecord(value)) return value;
  const alliances = isRecord(value.alliances) ? value.alliances : {};
  const alliance = (color: "red" | "blue") => {
    const side = alliances[color];
    if (!isRecord(side)) return null;
    return { team_keys: side.team_keys, score: side.score };
  };
  return {
    key: value.key,
    event_key: value.event_key,
    comp_level: value.comp_level,
    set_number: value.set_number,
    match_number: value.match_number,
    alliances: { red: alliance("red"), blue: alliance("blue") },
    winning_alliance: value.winning_alliance,
    score_breakdown: value.score_breakdown,
  };
}

function changedMatchKeys(
  previous: unknown,
  next: unknown,
  source: AnalyticsSourceKey,
): string[] | null | undefined {
  if (!Array.isArray(previous) || !Array.isArray(next)) return null;
  const keyOf = (value: unknown) => isRecord(value) && typeof value.key === "string" ? value.key : null;
  const before = new Map(previous.flatMap((match) => {
    const key = keyOf(match);
    return key === null ? [] : [[key, matchAnalyticsProjection(match, source)] as const];
  }));
  const after = new Map(next.flatMap((match) => {
    const key = keyOf(match);
    return key === null ? [] : [[key, matchAnalyticsProjection(match, source)] as const];
  }));
  if (before.size !== previous.length || after.size !== next.length) return null;
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((key) => JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key)))
    .sort();
  return changed.length > 0 ? changed : undefined;
}

async function recordAnalyticsInvalidation(
  transaction: DurableObjectTransactionLike,
  source: AnalyticsSourceKey,
  now: number,
  matchKeys: readonly string[] | null = null,
): Promise<void> {
  const current = await transaction.get<AnalyticsInvalidation>(ANALYTICS_INVALIDATION_KEY);
  const next = mergeAnalyticsInvalidations(
    current,
    planAnalyticsInvalidation(source, matchKeys, now),
  );
  await transaction.put(ANALYTICS_INVALIDATION_KEY, next);
  const existingDueAt = await transaction.get<number>(ANALYTICS_DUE_KEY);
  const requestedDueAt = now + 1_000;
  await transaction.put(
    ANALYTICS_DUE_KEY,
    existingDueAt === undefined ? requestedDueAt : Math.min(existingDueAt, requestedDueAt),
  );
  await transaction.delete(ANALYTICS_COHORT_RETRY_KEY);
  await transaction.put("analytics:status", "pending");
}

function hasAcquiredValue(state: EndpointState<unknown> | undefined): boolean {
  return Boolean(state && (state.lastFetchedAt !== null || state.lastWebhookAt !== null));
}



function buildAnalyticsInputRecord(
  inputKey: string,
  provider: string,
  resource: string,
  state: EndpointState<unknown> | undefined,
  recordCount: number,
  includedCount: number,
  now: number,
): FieldViewAnalyticsInputRecord {
  const unavailable = !state || state.status === "unknown" ||
    state.status === "unavailable" || state.status === "failed";
  const stale = Boolean(state && (
    state.status === "stale" ||
    (state.expiresAt !== null && state.expiresAt < now)
  ));
  const status = unavailable ? "unavailable"
    : stale || includedCount < recordCount ? "partial"
      : "available";
  const safeRecordCount = Math.max(0, recordCount);
  const safeIncludedCount = Math.max(0, Math.min(safeRecordCount, includedCount));
  return {
    input_key: inputKey,
    provider,
    resource,
    source_revision: state?.revision ?? null,
    fetched_at: state?.lastFetchedAt ?? state?.lastWebhookAt ?? null,
    record_count: safeRecordCount,
    included_count: safeIncludedCount,
    excluded_count: safeRecordCount - safeIncludedCount,
    status,
  };
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

  private async syncTeamActivity(active: boolean): Promise<void> {
    const namespace = this.env.TEAM_RUNTIME;
    if (!namespace) return;
    const roster = await this.storage.get<EndpointState<TBATeam[]>>(endpointStorageKey(TBA_ENDPOINTS.eventTeams(this.eventKey)));
    const teamKeys = Array.isArray(roster?.data)
      ? [...new Set(roster.data.map((team) => team?.key).filter((key): key is string => typeof key === "string" && /^frc[0-9]+$/.test(key)))]
      : [];
    const currentTeamKeys = new Set(teamKeys);
    const previousTeamKeys = await this.storage.get<string[]>("activity:team-keys") ?? [];
    const notifyTeamKeys = [...new Set([...previousTeamKeys, ...teamKeys])];
    const year = Number(this.eventKey.slice(0, 4));
    await Promise.all(notifyTeamKeys.map(async (teamKey) => {
      const shouldBeActive = active && currentTeamKeys.has(teamKey);
      const stub = namespace.get(namespace.idFromName(teamKey));
      const response = await stub.fetch(new Request("https://team-runtime/activity?year=" + year, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
          "X-FieldView-Team-Key": teamKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ event_key: this.eventKey, year, active: shouldBeActive }),
      }));
      if (!response.ok) throw new Error("Failed to update TeamRuntime activity for " + teamKey + ": HTTP " + response.status);
    }));
    await this.storage.put("activity:team-keys", active ? teamKeys : []);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const adminAuthorized = Boolean(this.env.RUNTIME_ADMIN_TOKEN) &&
      request.headers.get("Authorization") === "Bearer " + this.env.RUNTIME_ADMIN_TOKEN;
    const publicRead = request.method === "GET" &&
      (url.pathname === "/snapshot" || url.pathname === "/analytics" || url.pathname === "/stream");
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
      if (body.analyticsEnabled === false) await this.storage.put(ANALYTICS_ENABLED_KEY, false);
      else if (body.analyticsEnabled === true) await this.storage.put(ANALYTICS_ENABLED_KEY, true);
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
      await this.storage.put("lifecycle:state", lifecycle);
      if (lifecycle === "expired") {
        await this.cancelRecurringPolls(true);
        await this.syncTeamActivity(false);
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
      await this.syncTeamActivity(lifecycle === "active");
      // Lifecycle activation is also the initial-ingestion trigger.
      await this.alarm();
      return Response.json({ lifecycle, attempted: true, event_key: this.eventKey });
    }

    if (request.method === "POST" && url.pathname === "/recalculate") {
      await this.storage.put(ANALYTICS_ENABLED_KEY, true);
      const body: unknown = await request.json().catch(() => null);
      if (isRecord(body) && body.allowPartialCohort === true) {
        // The season-ingest controller calls this only after it has attempted
        // every TeamRuntime resource. Missing histories then become explicit
        // partial analytics evidence instead of an endless waiting state.
        await this.storage.put(ANALYTICS_ALLOW_PARTIAL_COHORT_KEY, true);
      }
      if (isRecord(body) && typeof body.seasonTeamRevision === "number" &&
          Number.isSafeInteger(body.seasonTeamRevision) && body.seasonTeamRevision >= 0) {
        await this.storage.put(ANALYTICS_SEASON_TEAM_REVISION_KEY, body.seasonTeamRevision);
      }
      await this.storage.put(ANALYTICS_DUE_KEY, Date.now());
      await this.storage.put("analytics:status", "pending");
      await this.storage.transaction((transaction) => this.rearm(transaction));
      await this.alarm();
      return Response.json({
        event_key: this.eventKey,
        analytics: {
          status: await this.storage.get<string>("analytics:status") ?? "pending",
          last_calculated_at: (await this.storage.get<AnalyticsPublication>(ANALYTICS_PUBLICATION_KEY))?.calculatedAt ?? null,
          source_revision: (await this.storage.get<AnalyticsPublication>(ANALYTICS_PUBLICATION_KEY))?.sourceRevision ?? null,
          last_error: await this.storage.get<string>("analytics:last-error") ?? null,
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/refresh") {
      const body: unknown = await request.json().catch(() => ({}));
      const requested = isRecord(body) && Array.isArray(body.endpoints) ? body.endpoints : [...this.allowedEndpoints];
      if (!requested.every((endpoint) => typeof endpoint === "string" && this.allowedEndpoints.has(endpoint))) {
        return Response.json({ error: "Refresh endpoints must belong to this event" }, { status: 400 });
      }
      const endpoints = requested as string[];
      const includeStatbotics = !isRecord(body) || body.includeStatbotics !== false;
      await this.ensureRecurringPolls(endpoints, 86_400_000);
      const manualEndpoints = [...endpoints];
      if (includeStatbotics) manualEndpoints.push(STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0));
      await this.enqueueManualPolls(manualEndpoints);
      await this.alarm();
      // Explicit refreshes also force a fresh analytics publication, even when
      // the provider returns an unchanged representation or HTTP 304.
      if (await this.storage.get<boolean>(ANALYTICS_ENABLED_KEY) !== false) {
        await this.storage.put(ANALYTICS_DUE_KEY, Date.now());
        await this.storage.put("analytics:status", "pending");
      }
      await this.storage.transaction((transaction) => this.rearm(transaction));
      await this.alarm();
      return Response.json({
        event_key: this.eventKey,
        requested: endpoints.length + (includeStatbotics ? 1 : 0),
        attempted: true,
        state: await (async () => {
          const entries = await this.storage.list<EndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
          return [...entries.values()].map((state) => ({
            endpoint: state.endpoint, status: state.status, revision: state.revision,
            fetched_at: state.lastFetchedAt, attempted_at: state.lastAttemptAt,
            http_status: (state as EndpointState<unknown> & { lastHttpStatus?: number }).lastHttpStatus ?? null,
            last_error: (state as EndpointState<unknown> & { lastError?: string | null }).lastError ?? null,
          }));
        })(),
        analytics: {
          status: await this.storage.get<string>("analytics:status") ?? "pending",
          last_calculated_at: (await this.storage.get<AnalyticsPublication>(ANALYTICS_PUBLICATION_KEY))?.calculatedAt ?? null,
          source_revision: (await this.storage.get<AnalyticsPublication>(ANALYTICS_PUBLICATION_KEY))?.sourceRevision ?? null,
          last_error: await this.storage.get<string>("analytics:last-error") ?? null,
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/ingest-resource") {
      const body: unknown = await request.json().catch(() => null);
      const endpoint = isRecord(body) && typeof body.endpoint === "string" ? body.endpoint : null;
      const statboticsEndpoint = STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0);
      if (!endpoint || (!this.allowedEndpoints.has(endpoint) && endpoint !== statboticsEndpoint)) {
        return Response.json({ error: "Resource endpoint is not part of this event" }, { status: 400 });
      }
      await this.enqueueManualPolls([endpoint]);
      await this.alarm();
      const state = await this.storage.get<EndpointState<unknown>>(endpointStorageKey(endpoint));
      const diagnostic = state as (EndpointState<unknown> & { lastError?: string | null; lastHttpStatus?: number | null }) | undefined;
      return Response.json({
        endpoint, queued: true, status: state?.status ?? "pending",
        revision: state?.revision ?? 0, last_fetched_at: state?.lastFetchedAt ?? null,
        http_status: diagnostic?.lastHttpStatus ?? null, last_error: diagnostic?.lastError ?? null,
      }, { status: 202 });
    }

    if (request.method === "POST" && url.pathname === "/statbotics-refresh") {
      const endpoint = STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0);
      await this.enqueueManualPolls([endpoint]);
      await this.alarm();
      if (await this.storage.get<boolean>(ANALYTICS_ENABLED_KEY) !== false) {
        await this.storage.put(ANALYTICS_DUE_KEY, Date.now());
        await this.storage.put("analytics:status", "pending");
      }
      await this.storage.transaction((transaction) => this.rearm(transaction));
      await this.alarm();
      const state = await this.storage.get<EndpointState<unknown>>(endpointStorageKey(endpoint));
      return Response.json({
        scheduled: true, attempted: true, event_key: this.eventKey, endpoint,
        status: state?.status ?? "unknown", revision: state?.revision ?? 0,
        record_count: Array.isArray(state?.providerData) ? state.providerData.length : 0,
        fetched_at: state?.lastFetchedAt ?? null,
        analytics_status: await this.storage.get<string>("analytics:status") ?? "pending",
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
      if (body.analyticsEnabled === false) await this.storage.put(ANALYTICS_ENABLED_KEY, false);
      else if (body.analyticsEnabled === true) await this.storage.put(ANALYTICS_ENABLED_KEY, true);
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
      await this.storage.put(ANALYTICS_ENABLED_KEY, true);
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
    if (request.method === "GET" && url.pathname === "/analytics") {
      const publication = await this.storage.get<AnalyticsPublication>(ANALYTICS_PUBLICATION_KEY);
      const revision = await this.storage.get<number>(ANALYTICS_REVISION_KEY) ?? 0;
      const endpointStates = await this.storage.list<EndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      const expectedEndpoints = [...eventResourceEndpoints(this.eventKey), STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0)];
      const currentSourceRevision = expectedEndpoints.reduce((total, endpoint) =>
        total + (endpointStates.get(endpointStorageKey(endpoint))?.revision ?? 0), 0);
      const storedStatus = await this.storage.get<string>("analytics:status") ?? (publication ? "succeeded" : "pending");
      const analyticsStatus = publication && publication.sourceRevision !== currentSourceRevision ? "stale" : storedStatus;
      return Response.json({
        event_key: this.eventKey,
        revision,
        status: analyticsStatus,
        season_team_revision: publication?.seasonTeamRevision ?? null,
        due_at: await this.storage.get<number>(ANALYTICS_DUE_KEY) ?? null,
        calculated_at: publication?.calculatedAt ?? null,
        source_revision: publication?.sourceRevision ?? null,
        pending_invalidation: await this.storage.get<AnalyticsInvalidation>(ANALYTICS_INVALIDATION_KEY) ?? null,
        publication: publication ?? null,
      }, {
        headers: { "X-FieldView-Analytics-Version": String(revision), "Cache-Control": "no-store" },
      });
    }

    if (request.method === "POST" && url.pathname === "/team-state-changed") {
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || typeof body.team_key !== "string" ||
          !/^(?:frc)?[0-9]+$/.test(body.team_key) ||
          !Number.isSafeInteger(body.team_state_revision) || (body.team_state_revision as number) < 0) {
        return Response.json({ error: "Invalid team state change notification" }, { status: 400 });
      }
      await this.storage.transaction(async (transaction) => {
        await transaction.put(ANALYTICS_DUE_KEY, Date.now());
        await transaction.put("analytics:status", "pending");
        await transaction.put("snapshot-revision", (await transaction.get<number>("snapshot-revision") ?? 0) + 1);
        await transaction.delete(ANALYTICS_COHORT_RETRY_KEY);
        await this.rearm(transaction);
      });
      return Response.json({ accepted: true, event_key: this.eventKey, team_key: body.team_key });
    }

    if (request.method === "POST" && url.pathname === "/publish-state") {
      const publication = await this.publishEventState();
      return Response.json({
        event_key: this.eventKey, status: publication.status,
        source_revision: publication.sourceRevision, generated_at: publication.generatedAt,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "GET" && url.pathname === "/snapshot") {
      // Demand-driven acquisition: persist missing/stale work and return the
      // current publication immediately. The Durable Object alarm performs
      // provider I/O after this request has completed.
      const now = Date.now();
      const resources = [...this.allowedEndpoints];
      const states = await this.storage.list<EndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      const needed = resources.filter((endpoint) => {
        const state = states.get(endpointStorageKey(endpoint));
        return !state || (state.lastFetchedAt === null && state.status !== "unavailable") || state.status === "failed" || state.status === "stale" ||
          (state.expiresAt !== null && state.expiresAt <= now);
      });
      if (needed.length > 0) {
        await this.ensureRecurringPolls(resources, 86_400_000);
        await this.enqueueManualPolls(needed);
      }
      const statboticsEndpoint = STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0);
      const statboticsState = states.get(endpointStorageKey(statboticsEndpoint));
      if (!statboticsState || (statboticsState.lastFetchedAt === null && statboticsState.status !== "unavailable") ||
          statboticsState.status === "failed" || statboticsState.status === "stale" ||
          (statboticsState.expiresAt !== null && statboticsState.expiresAt <= now)) {
        await this.enqueueManualPolls([statboticsEndpoint]);
      }
      if (await this.storage.get<boolean>(ANALYTICS_ENABLED_KEY) !== false &&
          !(await this.storage.get<AnalyticsPublication>(ANALYTICS_PUBLICATION_KEY))) {
        await this.storage.put(ANALYTICS_DUE_KEY, now);
        await this.storage.put("analytics:status", "pending");
        await this.storage.transaction((transaction) => this.rearm(transaction));
      }
      const publication = await this.publishEventState();
      return Response.json(publication.state, {
        headers: {
          "X-FieldView-Snapshot-Version": String(publication.snapshotVersion),
          "X-FieldView-Event-State-Status": publication.status,
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/view") {
      const publication = await this.publishEventState();
      const state = publication.state;
      const expected = (state.teams ?? []).map((team) => team.key);
      const present = new Set((state.team_states ?? []).map((team) => team.team_key));
      const pending = expected.filter((teamKey) => !present.has(teamKey));
      return Response.json({
        event: Object.fromEntries(Object.entries(state).filter(([key]) => key !== "analytics" && key !== "team_states")),
        analytics: state.analytics ?? null,
        team_states: state.team_states ?? [],
        team_state_coverage: {
          state: pending.length === 0 ? "complete" : "partial",
          expected_count: expected.length,
          materialized_count: present.size,
          pending_team_keys: pending,
        },
      }, { headers: { "X-FieldView-Event-State-Status": publication.status, "Cache-Control": "no-store" } });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const entries = await this.storage.list<EndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      const tasks = await this.storage.list<PollTask>({ prefix: TASK_PREFIX });
      const analyticsPublication = await this.storage.get<AnalyticsPublication>(ANALYTICS_PUBLICATION_KEY);
      const eventStatePublication = await this.storage.get<EventStatePublication>(EVENT_STATE_PUBLICATION_KEY);
      const eventAnalytics = analyticsPublication?.eventAnalytics;
      const cohortStatus = isRecord(eventAnalytics) && isRecord(eventAnalytics.season_cohort)
        ? eventAnalytics.season_cohort.state : null;
      const expectedEndpoints = [...eventResourceEndpoints(this.eventKey), STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0)];
      const currentSourceRevision = expectedEndpoints.reduce((total, endpoint) =>
        total + (entries.get(endpointStorageKey(endpoint))?.revision ?? 0), 0);
      const eventStateStatus = !eventStatePublication ? "missing"
        : eventStatePublication.sourceRevision === currentSourceRevision ? eventStatePublication.status : "stale";
      const storedAnalyticsStatus = await this.storage.get<string>("analytics:status") ?? (analyticsPublication ? "succeeded" : "pending");
      const analyticsStatus = analyticsPublication && analyticsPublication.sourceRevision !== currentSourceRevision
        ? "stale" : storedAnalyticsStatus;
      return Response.json({
        event_key: this.eventKey,
        source_revision: currentSourceRevision,
        event_state: {
          status: eventStateStatus,
          generated_at: eventStatePublication?.generatedAt ?? null,
          source_revision: eventStatePublication?.sourceRevision ?? null,
        },
        analytics: {
          revision: await this.storage.get<number>(ANALYTICS_REVISION_KEY) ?? 0,
          due_at: await this.storage.get<number>(ANALYTICS_DUE_KEY) ?? null,
          status: analyticsStatus,
          last_calculated_at: analyticsPublication?.calculatedAt ?? null,
          source_revision: analyticsPublication?.sourceRevision ?? null,
          season_team_revision: analyticsPublication?.seasonTeamRevision ?? null,
          pending_invalidation: await this.storage.get<AnalyticsInvalidation>(ANALYTICS_INVALIDATION_KEY) ?? null,
          cohort_status: cohortStatus,
          last_error: await this.storage.get<string>("analytics:last-error") ?? null,
        },
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
        endpoints: Object.fromEntries([...entries.entries()].map(([key, state]) => {
          const value = state.providerData ?? state.data;
          const records = Array.isArray(value) ? value : value == null ? [] : [value];
          const hasEpa = (record: unknown): boolean => {
            if (!isRecord(record)) return false;
            if (isRecord(record.predictions) && record.predictions.statbotics !== undefined) return true;
            for (const mapName of ["pre_epas", "epas"]) {
              const epaMap = isRecord(record[mapName]) ? Object.values(record[mapName] as Record<string, unknown>) : [];
              if (epaMap.some((entry) => isRecord(entry) && typeof entry.epa === "number")) return true;
            }
            for (const alliance of ["red", "blue"]) {
              const teams = isRecord(record.teams) && Array.isArray(record.teams[alliance])
                ? record.teams[alliance] as unknown[] : [];
              if (teams.some((team) => isRecord(team) &&
                (typeof team.epa === "number" || typeof team.pre_epa === "number"))) return true;
            }
            return false;
          };
          const statbotics = key.includes("/matches?event=");
          const included = statbotics ? records.filter(hasEpa).length : records.length;
          const diagnostic = state as EndpointState<unknown> & { lastError?: string | null; lastHttpStatus?: number | null };
          const { data: omittedData, providerData: omittedProviderData, ...safeState } = state;
          void omittedData;
          void omittedProviderData;
          return [key, {
            ...safeState,
            record_count: records.length,
            included_count: included,
            excluded_count: Math.max(0, records.length - included),
            data_kind: Array.isArray(value) ? "array" : value === null ? "empty" : typeof value,
            lastError: diagnostic.lastError ?? null,
            lastHttpStatus: diagnostic.lastHttpStatus ?? null,
          }] as const;
        })),
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private async collectSeasonCohort(
    eventState: ReturnType<typeof normalizeFieldViewEventState>,
  ): Promise<{
    cohort: import("../../../packages/domain/src/analytics.ts").FieldViewSeasonCohortSnapshot;
    inputs: FieldViewAnalyticsInputRecord[];
  } | undefined> {
    const event = eventState.event;
    const teams = eventState.teams;
    const namespace = this.env.TEAM_RUNTIME;
    if (!event || !teams || !namespace) return undefined;
    const year = Number(event.key.slice(0, 4));
    if (!Number.isSafeInteger(year) || year < 1992) return undefined;
    const participants = teams.flatMap((team) =>
      typeof team.team_number === "number" && typeof team.key === "string"
        ? [{ teamNumber: team.team_number, teamKey: team.key }]
        : [],
    );
    const results = await Promise.all(participants.map(async ({ teamKey }) => {
      try {
        if (this.env.TASK_SCHEDULER && this.env.RUNTIME_ADMIN_TOKEN) {
          const scheduler = this.env.TASK_SCHEDULER.get(this.env.TASK_SCHEDULER.idFromName("global"));
          await scheduler.fetch(new Request("https://task-scheduler/register", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ kind: "team", key: teamKey }),
          }));
        }
        const stub = namespace.get(namespace.idFromName(teamKey));
        const response = await stub.fetch(new Request("https://team-runtime/snapshot?year=" + year + "&noSchedule=1", {
          method: "GET",
          headers: {
            Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
            "X-FieldView-Team-Key": teamKey,
          },
        }));
        if (!response.ok) return { teamKey, snapshot: null, revision: null };
        return {
          teamKey,
          snapshot: await response.json() as FieldViewTeamState,
          revision: response.headers.get("X-FieldView-Snapshot-Version") === null
            ? null : Number(response.headers.get("X-FieldView-Snapshot-Version")),
        };
      } catch {
        return { teamKey, snapshot: null, revision: null };
      }
    }));
    const snapshots = results.map((item) => item.snapshot);
    const inputs: FieldViewAnalyticsInputRecord[] = results.map(({ teamKey, snapshot, revision }) => {
      const source = snapshot?.sources.statbotics_team_events;
      const events = snapshot?.events ?? [];
      const statboticsEvents = snapshot?.statbotics_events ?? [];
      const fetchedAt = typeof source?.retrieved_at === "string"
        ? Date.parse(source.retrieved_at) : null;
      const status = !source || source.status === "failed" || source.status === "unavailable" ||
        snapshot?.statbotics_events === undefined || snapshot?.statbotics_events === null
        ? "unavailable" as const
        : source.status === "stale" || statboticsEvents.length < events.length
          ? "partial" as const : "available" as const;
      return {
        input_key: "team:" + teamKey + ":statbotics-team-events",
        provider: "statbotics",
        resource: "team-events",
        source_revision: revision,
        fetched_at: fetchedAt !== null && Number.isFinite(fetchedAt) ? fetchedAt : null,
        record_count: events.length,
        included_count: Math.min(events.length, statboticsEvents.length),
        excluded_count: Math.max(0, events.length - statboticsEvents.length),
        status,
      };
    });
    return {
      cohort: buildCanonicalSeasonCohort(
        event, participants.map((team) => team.teamNumber), snapshots, Date.now(),
      ),
      inputs,
    };
  }

  private async calculateTeamEventStates(
    eventState: ReturnType<typeof normalizeFieldViewEventState>,
    cohort: import("../../../packages/domain/src/analytics.ts").FieldViewSeasonCohortSnapshot,
    eventSourceRevision: number,
  ): Promise<FieldViewTeamEventState[]> {
    const namespace = this.env.TEAM_RUNTIME;
    if (!namespace || !this.env.RUNTIME_ADMIN_TOKEN) return [];
    const teams = eventState.teams ?? [];
    const results = await Promise.all(teams.map(async (team) => {
      const teamKey = team.key;
      try {
        const stub = namespace.get(namespace.idFromName(teamKey));
        const headers = {
          Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
          "X-FieldView-Team-Key": teamKey,
          "Content-Type": "application/json",
        };
        const calculated = await stub.fetch(new Request("https://team-runtime/event-analytics?year=" + this.eventKey.slice(0, 4), {
          method: "POST",
          headers,
          body: JSON.stringify({
            event_key: this.eventKey,
            event_source_revision: eventSourceRevision,
            event_state: eventState,
            cohort,
          }),
        }));
        if (!calculated.ok) return null;
        const response = await stub.fetch(new Request(
          "https://team-runtime/event-state?event_key=" + encodeURIComponent(this.eventKey) + "&year=" + this.eventKey.slice(0, 4),
          { headers: { Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Team-Key": teamKey } },
        ));
        if (!response.ok) return null;
        return await response.json() as FieldViewTeamEventState;
      } catch {
        return null;
      }
    }));
    return results.filter((item): item is FieldViewTeamEventState => item !== null);
  }

  private async readTeamEventStates(
    eventState: ReturnType<typeof normalizeFieldViewEventState>,
  ): Promise<FieldViewTeamEventState[]> {
    const namespace = this.env.TEAM_RUNTIME;
    if (!namespace || !this.env.RUNTIME_ADMIN_TOKEN) return [];
    return (await Promise.all((eventState.teams ?? []).map(async (team) => {
      try {
        const stub = namespace.get(namespace.idFromName(team.key));
        const response = await stub.fetch(new Request(
          "https://team-runtime/event-state?event_key=" + encodeURIComponent(this.eventKey) + "&year=" + this.eventKey.slice(0, 4),
          { headers: { Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Team-Key": team.key } },
        ));
        if (!response.ok) return null;
        return await response.json() as FieldViewTeamEventState;
      } catch {
        return null;
      }
    }))).filter((item): item is FieldViewTeamEventState => item !== null);
  }

  private async buildEventState(calculateAnalytics = false, allowPartialCohort = false): Promise<{ version: number; sourceRevision: number; analyticsInputsComplete?: boolean; state: ReturnType<typeof normalizeFieldViewEventState> }> {
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
      sourceRevision: (await Promise.all([...endpoints, statboticsMatchesEndpoint].map(async (endpoint) =>
        await transaction.get<EndpointState<unknown>>(endpointStorageKey(endpoint))))).reduce(
          (total, resource) => total + (resource?.revision ?? 0), 0,
        ),
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

    const normalizedState = normalizeFieldViewEventState({
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
      });
    const canonicalMatches = normalizedState.matches ?? [];
    const tbaMatchRecords = Array.isArray(matchesState?.data) ? matchesState.data : [];
    const tbaTeamRecords = Array.isArray(teamsState?.data) ? teamsState.data : [];
    const statboticsIncludedCount = canonicalMatches.filter((match) =>
      match.predictions.statbotics !== undefined ||
      match.teams.red.some((team) => team.pre_epa !== undefined || team.epa !== undefined) ||
      match.teams.blue.some((team) => team.pre_epa !== undefined || team.epa !== undefined),
    ).length;
    const inputRecords: FieldViewAnalyticsInputRecord[] = [
      buildAnalyticsInputRecord(
        "tba-event-matches", "tba", "event-matches", matchesState,
        tbaMatchRecords.length, tbaMatchRecords.length, now,
      ),
      buildAnalyticsInputRecord(
        "tba-event-teams", "tba", "event-teams", teamsState,
        tbaTeamRecords.length,
        tbaTeamRecords.filter((team) => typeof team.team_number === "number").length,
        now,
      ),
      buildAnalyticsInputRecord(
        "statbotics-event-matches", "statbotics", "event-matches", statboticsMatchesState,
        canonicalMatches.length, statboticsIncludedCount, now,
      ),
    ];
    if (calculateAnalytics) {
      const seasonCollection = await this.collectSeasonCohort(normalizedState);
      const analyticsInputs = [...inputRecords, ...(seasonCollection?.inputs ?? [])];
      // EventRuntime calculates event/match analytics only. TeamRuntime owns
      // the per-team calculations and persists each TeamEventState.
      const eventAnalyticsState = await calculateCanonicalMatchAnalytics(
        normalizedState,
        inputRecords,
        undefined,
        { includeTeamAnalytics: false },
      );
      const teamStates = seasonCollection
        ? await this.calculateTeamEventStates(eventAnalyticsState, seasonCollection.cohort, state.sourceRevision)
        : [];
      const expectedTeamCount = normalizedState.teams?.length ?? 0;
      const teamStatesComplete = expectedTeamCount > 0 && teamStates.length === expectedTeamCount &&
        seasonCollection?.cohort.state === "complete";
      return {
        version: state.version,
        sourceRevision: state.sourceRevision,
        analyticsInputsComplete: analyticsInputs.every((input) => input.status === "available") && teamStatesComplete,
        state: { ...eventAnalyticsState, team_states: teamStates },
      };
    }

    const publication = await this.storage.get<AnalyticsPublication>(ANALYTICS_PUBLICATION_KEY);
    if (!publication) return { version: state.version, sourceRevision: state.sourceRevision, state: normalizedState };
    const matchAnalytics = new Map(publication.matches.map((match) => [match.key, match]));
    const matches = normalizedState.matches === undefined || normalizedState.matches === null
      ? normalizedState.matches
      : normalizedState.matches.map((match) => {
          const published = matchAnalytics.get(match.key);
          return published ? {
            ...match,
            ...(published.analysis === undefined ? {} : { analysis: published.analysis as typeof match.analysis }),
            ...(published.flags === undefined ? {} : { flags: published.flags as typeof match.flags }),
          } : match;
        });
    const team_states = await this.readTeamEventStates(normalizedState);
    return {
      version: state.version,
      sourceRevision: state.sourceRevision,
      state: {
        ...normalizedState,
        ...(matches === undefined ? {} : { matches }),
        team_states,
        ...(publication.eventAnalytics === undefined ? {} : { analytics: publication.eventAnalytics as typeof normalizedState.analytics }),
      },
    };
  }

  async schedulePolls(endpoints: string[], intervalMs: number, now = Date.now(), forceImmediate = false): Promise<void> {
    if (endpoints.some((endpoint) => !this.allowedEndpoints.has(endpoint))) {
      throw new Error("Only TBA event endpoints can be scheduled for recurring polling");
    }
    await this.storage.transaction(async (transaction) => {
      for (const endpoint of endpoints) {
        const key = taskStorageKey(endpoint);
        const previous = await transaction.get<PollTask>(key);
        const unchanged = !forceImmediate && previous?.retryOnFailure === true && previous.intervalMs === intervalMs;
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
        const unchangedTask = previous !== undefined &&
          previous.endpoint === task.endpoint &&
          previous.dueAt === task.dueAt &&
          previous.intervalMs === task.intervalMs &&
          previous.generation === task.generation &&
          previous.attempts === task.attempts &&
          previous.retryOnFailure === task.retryOnFailure &&
          previous.maxAttempts === task.maxAttempts &&
          previous.authoritativeRefetchAt === task.authoritativeRefetchAt;
        if (!unchangedTask) await transaction.put(key, task);
      }
      await this.rearm(transaction);
    });
  }

  private async enqueueManualPolls(endpoints: string[]): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<ManualPollRequest[]>(MANUAL_QUEUE_KEY) ?? [];
      const byEndpoint = new Map(current.map((item) => [item.endpoint, item]));
      for (const endpoint of endpoints) {
        const previous = byEndpoint.get(endpoint);
        byEndpoint.set(endpoint, { endpoint, dueAt: Math.min(previous?.dueAt ?? Date.now(), Date.now()), attempts: previous?.attempts ?? 0 });
      }
      const next = [...byEndpoint.values()];
      const unchanged = current.length === next.length && current.every((item, index) =>
        item.endpoint === next[index]?.endpoint &&
        item.dueAt === next[index]?.dueAt &&
        item.attempts === next[index]?.attempts);
      if (!unchanged) await transaction.put(MANUAL_QUEUE_KEY, next);
      await this.rearm(transaction);
    });
  }

  private async ensureRecurringPolls(endpoints: string[], intervalMs: number): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      for (const endpoint of endpoints) {
        const key = taskStorageKey(endpoint);
        const existing = await transaction.get<PollTask>(key);
        if (existing) continue;
        await transaction.put(key, {
          endpoint, dueAt: Date.now() + intervalMs, intervalMs,
          generation: 1, attempts: 0, retryOnFailure: true,
        } satisfies PollTask);
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

  private async publishEventState(): Promise<EventStatePublication> {
    const eventResources = eventResourceEndpoints(this.eventKey);
    const statboticsResource = STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0);
    const allResources = [...eventResources, statboticsResource];

    // Fast path: when no source or published-snapshot revision has changed,
    // reuse the durable normalized publication. Read endpoint metadata only to
    // keep completeness/freshness status accurate as resources expire.
    const cached = await this.storage.transaction(async (transaction) => {
      const previous = await transaction.get<EventStatePublication>(EVENT_STATE_PUBLICATION_KEY);
      if (!previous) return null;
      const version = await transaction.get<number>("snapshot-revision") ?? 0;
      const resources = await Promise.all(allResources.map((endpoint) =>
        transaction.get<EndpointState<unknown>>(endpointStorageKey(endpoint))));
      const sourceRevision = resources.reduce((total, resource) => total + (resource?.revision ?? 0), 0);
      if (previous.snapshotVersion !== version || previous.sourceRevision !== sourceRevision) return null;
      const now = Date.now();
      const acquiredCount = resources.filter((resource) =>
        resource?.lastFetchedAt != null || resource?.lastWebhookAt != null).length;
      const hasIncompleteResource = resources.some((resource) =>
        !resource || resource.status === "unknown" || resource.status === "stale" ||
        resource.status === "failed" || resource.status === "unavailable" ||
        (resource.expiresAt !== null && resource.expiresAt < now));
      // The cached normalized DTO embeds source freshness metadata. Rebuild it
      // when a source expires so callers see stale provenance, not old "available".
      if (resources.some((resource) => resource?.expiresAt !== null && resource?.expiresAt !== undefined && resource.expiresAt < now)) {
        return null;
      }
      const status = acquiredCount === allResources.length && !hasIncompleteResource
        ? "complete" as const : acquiredCount > 0 ? "partial" as const : "failed" as const;
      if (previous.status !== status) {
        const updated = { ...previous, status };
        await transaction.put(EVENT_STATE_PUBLICATION_KEY, updated);
        return updated;
      }
      return previous;
    });
    if (cached) return cached;

    const result = await this.buildEventState();
    const resourceStates = await Promise.all(allResources.map((endpoint) =>
      this.storage.get<EndpointState<unknown>>(endpointStorageKey(endpoint))));
    const acquiredCount = resourceStates.filter((resource) =>
      resource?.lastFetchedAt != null || resource?.lastWebhookAt != null).length;
    const hasIncompleteResource = resourceStates.some((resource) =>
      !resource || resource.status === "unknown" || resource.status === "stale" ||
      resource.status === "failed" || resource.status === "unavailable" ||
      (resource.expiresAt !== null && resource.expiresAt < Date.now()));
    const publication: EventStatePublication = {
      sourceRevision: result.sourceRevision,
      snapshotVersion: result.version,
      generatedAt: Date.now(),
      status: acquiredCount === allResources.length && !hasIncompleteResource
        ? "complete" : acquiredCount > 0 ? "partial" : "failed",
      state: result.state,
    };
    const previous = await this.storage.get<EventStatePublication>(EVENT_STATE_PUBLICATION_KEY);
    if (!previous || previous.sourceRevision !== publication.sourceRevision ||
        previous.snapshotVersion !== publication.snapshotVersion || previous.status !== publication.status) {
      await this.storage.put(EVENT_STATE_PUBLICATION_KEY, publication);
    }
    return publication;
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
      const due = [...tasks.values()].filter((task) => task.dueAt <= now)
        .sort((left, right) => left.dueAt - right.dueAt || left.endpoint.localeCompare(right.endpoint));
      if (due.length > 0 && !hasEventIdentity) {
        throw new Error("Cannot execute event alarm without persisted event identity");
      }
      const queued = await transaction.get<ManualPollRequest[]>(MANUAL_QUEUE_KEY) ?? [];
      const manualDue = queued.filter((item) => item.dueAt <= now);
      if (manualDue.length > 0 && !hasEventIdentity) throw new Error("Cannot execute manual event work without persisted event identity");

      const manualEndpoints = new Set(manualDue.map((item) => item.endpoint));
      const readyTasks = due.filter((task) => !manualEndpoints.has(task.endpoint));
      for (const task of readyTasks) {
        await transaction.put(taskStorageKey(task.endpoint), {
          ...task, dueAt: now + this.retryDelay(task), attempts: task.attempts + 1,
        });
      }
      if (manualDue.length > 0) {
        const dueEndpoints = new Set(manualDue.map((item) => item.endpoint));
        await transaction.put(MANUAL_QUEUE_KEY, queued.map((item) =>
          dueEndpoints.has(item.endpoint) ? { ...item, dueAt: now + 60_000 } : item));
      }

      const analyticsDueAt = await transaction.get<number>(ANALYTICS_DUE_KEY);
      const analyticsDue = analyticsDueAt !== undefined && analyticsDueAt <= now;
      if (analyticsDue) await transaction.delete(ANALYTICS_DUE_KEY);
      await this.rearm(transaction);
      return { due: readyTasks, manualDue, analyticsDue };
    });

    // Manual work is independent of recurring poll tasks and is always serviced first.
    await Promise.all(dueTasks.manualDue.map(async (item) => {
      const result = await this.pollEndpoint(item.endpoint);
      const latest = await this.storage.get<EndpointState<unknown>>(endpointStorageKey(item.endpoint));
      const retryableFailure = !result && latest?.status === "failed";
      const retryAt = Date.now() + Math.min(60_000, 1_000 * (2 ** Math.min(item.attempts, 6)));
      await this.storage.transaction(async (transaction) => {
        const queue = await transaction.get<ManualPollRequest[]>(MANUAL_QUEUE_KEY) ?? [];
        const next = queue.filter((queued) => queued.endpoint !== item.endpoint);
        if (retryableFailure && item.attempts < 8) {
          // Provider failures are retried without discarding the last-good representation.
          next.push({ ...item, dueAt: retryAt, attempts: item.attempts + 1 });
        }
        await transaction.put(MANUAL_QUEUE_KEY, next);
        await this.rearm(transaction);
      });
    }));

    await Promise.all(dueTasks.due.map(async (task) => {
      const succeeded = await this.pollEndpoint(task.endpoint);
      if (task.retryOnFailure === false) {
        await this.storage.delete(taskStorageKey(task.endpoint));
        return;
      }
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
    }));
    if (dueTasks.analyticsDue) await this.recalculateAnalytics();
  }

  private async recalculateAnalytics(): Promise<void> {
    // Run calculations from the Durable Object alarm, never from public reads.
    // If sources change during calculation, discard the result and coalesce
    // another run rather than publishing a mixed-revision analytics payload.
    await this.storage.put("analytics:status", "running");
    let calculated: { version: number; sourceRevision: number; analyticsInputsComplete?: boolean; state: ReturnType<typeof normalizeFieldViewEventState> };
    try {
      const allowPartialCohort = await this.storage.get<boolean>(ANALYTICS_ALLOW_PARTIAL_COHORT_KEY) === true;
      calculated = await this.buildEventState(true, allowPartialCohort);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const waitingForCohort = detail.startsWith("SEASON_COHORT_NOT_READY:");
      await this.storage.transaction(async (transaction) => {
        await transaction.put("analytics:status", waitingForCohort ? "waiting-for-cohort" : "failed");
        await transaction.put(ANALYTICS_DUE_KEY, Date.now() + (waitingForCohort ? ANALYTICS_COHORT_RETRY_DELAY_MS : 30_000));
        if (waitingForCohort) await transaction.delete("analytics:last-error");
        else await transaction.put("analytics:last-error", detail.slice(0, 300));
        await this.rearm(transaction);
      });
      return;
    }
    const state = calculated.state;
    const seasonTeamRevision = await this.storage.get<number>(ANALYTICS_SEASON_TEAM_REVISION_KEY);
    const publication: AnalyticsPublication = {
      sourceRevision: calculated.sourceRevision,
      ...(seasonTeamRevision === undefined ? {} : { seasonTeamRevision }),
      calculatedAt: Date.now(),
      matches: (state.matches ?? []).map((match) => ({
        key: match.key,
        ...(match.analysis === undefined ? {} : { analysis: match.analysis }),
        ...(match.flags === undefined ? {} : { flags: match.flags }),
      })),
      ...(state.analytics === undefined ? {} : { eventAnalytics: state.analytics }),
    };
    const publishedVersion = await this.storage.transaction(async (transaction) => {
      const currentRevision = await transaction.get<number>("snapshot-revision") ?? 0;
      if (currentRevision !== calculated.version) {
        await transaction.put(ANALYTICS_DUE_KEY, Date.now() + 1_000);
        await transaction.delete(ANALYTICS_COHORT_RETRY_KEY);
        await transaction.put("analytics:status", "pending");
        await this.rearm(transaction);
        return null;
      }
      const analyticsRevision = (await transaction.get<number>(ANALYTICS_REVISION_KEY) ?? 0) + 1;
      publication.analyticsRevision = analyticsRevision;
      await transaction.put(ANALYTICS_REVISION_KEY, analyticsRevision);
      await transaction.put(ANALYTICS_PUBLICATION_KEY, publication);
      await transaction.delete(ANALYTICS_INVALIDATION_KEY);
      const allowPartialTeamStates = await transaction.get<boolean>(ANALYTICS_ALLOW_PARTIAL_COHORT_KEY) === true;
      const collectionPartial = isRecord(calculated.state.analytics) &&
        isRecord(calculated.state.analytics.collection) &&
        calculated.state.analytics.collection.state === "partial";
      const teamStatesIncomplete = this.env.TEAM_RUNTIME && calculated.analyticsInputsComplete === false;
      const analyticsIncomplete = Boolean(teamStatesIncomplete || collectionPartial);
      const retries = await transaction.get<number>(ANALYTICS_COHORT_RETRY_KEY) ?? 0;
      if (teamStatesIncomplete && !allowPartialTeamStates && retries < ANALYTICS_COHORT_MAX_RETRIES) {
        await transaction.put(ANALYTICS_COHORT_RETRY_KEY, retries + 1);
        await transaction.put(ANALYTICS_DUE_KEY, Date.now() + ANALYTICS_COHORT_RETRY_DELAY_MS);
        await transaction.put("analytics:status", "partial");
      } else {
        await transaction.delete(ANALYTICS_COHORT_RETRY_KEY);
        await transaction.delete(ANALYTICS_DUE_KEY);
        await transaction.put("analytics:status", analyticsIncomplete ? "partial" : "succeeded");
      }
      await transaction.delete(ANALYTICS_ALLOW_PARTIAL_COHORT_KEY);
      await transaction.delete(ANALYTICS_SEASON_TEAM_REVISION_KEY);
      await transaction.delete("analytics:last-error");
      const nextRevision = currentRevision + 1;
      await transaction.put("snapshot-revision", nextRevision);
      await this.rearm(transaction);
      return nextRevision;
    });
    if (publishedVersion !== null) {
      const analyticsRevision = await this.storage.get<number>(ANALYTICS_REVISION_KEY) ?? 0;
      await Promise.all([
        this.publishSnapshotRevision(publishedVersion),
        this.publishAnalyticsRevision(analyticsRevision),
      ]);
    }
  }

  private async publishAnalyticsRevision(version: number): Promise<void> {
    if (!this.env.MULTIPLEXER || !this.env.RUNTIME_ADMIN_TOKEN) return;
    const multiplexer = this.env.MULTIPLEXER.get(this.env.MULTIPLEXER.idFromName("shared"));
    await multiplexer.fetch(new Request("https://fieldview-multiplexer/internal/notify", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ topic: "analytics", event_key: this.eventKey, version }),
    })).catch(() => undefined);
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
    const analyticsDueAt = await transaction.get<number>(ANALYTICS_DUE_KEY);
    const manualQueue = await transaction.get<ManualPollRequest[]>(MANUAL_QUEUE_KEY) ?? [];
    const nextDue = [...tasks.values()].reduce<number | null>(
      (next, task) => next === null || task.dueAt < next ? task.dueAt : next,
      [...manualQueue.map((item) => item.dueAt), completedUntil, analyticsDueAt]
        .filter((value): value is number => value !== undefined)
        .reduce<number | null>((next, value) => next === null || value < next ? value : next, null),
    );
    const currentAlarm = await transaction.getAlarm?.();
    if (nextDue === null) {
      if (currentAlarm !== null && currentAlarm !== undefined) await transaction.deleteAlarm();
    } else if (currentAlarm !== nextDue) {
      await transaction.setAlarm(nextDue);
    }
  }

  private async pollEndpoint(endpoint: string, options: { suppressStatboticsRefresh?: boolean } = {}): Promise<boolean> {
    const isStatboticsEndpoint = endpoint === STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0);
    const stored = await this.storage.get<EndpointState<unknown>>(endpointStorageKey(endpoint));
    const initial = stored ?? createEndpointState<unknown>(endpoint);
    const requestSnapshot = createPollRequestSnapshot(initial);
    const headers = new Headers();
    if (requestSnapshot.ifNoneMatch) headers.set("If-None-Match", requestSnapshot.ifNoneMatch);

    let responseState:
      | { status: "modified"; data: unknown; etag: string | null; expiresAt: number | null }
      | { status: "not-modified"; expiresAt: number | null }
      | { status: "unavailable"; httpStatus: number }
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
      } else if (response.status === 404) {
        responseState = { status: "unavailable", httpStatus: response.status };
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
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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
        (current, fetched) => isStatboticsEndpoint
          ? fetched
          : reconcilePolledEndpoint(endpoint, current, fetched),
      );
      const nextWithDiagnostic = {
        ...next,
        lastError: responseState.status === "failed" ? responseState.reason : null,
        lastHttpStatus: responseState.status === "modified" ? 200
          : responseState.status === "not-modified" ? 304
            : responseState.status === "unavailable" ? responseState.httpStatus : null,
      };
      await transaction.put(key, nextWithDiagnostic);
      if (next.revision !== latest.revision) {
        const snapshotRevision = await transaction.get<number>("snapshot-revision") ?? 0;
        await transaction.put("snapshot-revision", snapshotRevision + 1);
        const analyticsSource = analyticsSourceForEndpoint(endpoint, this.eventKey);
        const analyticsEnabled = await transaction.get<boolean>(ANALYTICS_ENABLED_KEY) !== false;
        if (analyticsSource && analyticsEnabled) {
          const matchKeys = analyticsSource === "tba-event-matches" || analyticsSource === "statbotics-event-matches"
            ? changedMatchKeys(latest.providerData, next.providerData, analyticsSource)
            : null;
          // undefined means the endpoint changed only in non-analytic metadata.
          if (matchKeys !== undefined) {
            await recordAnalyticsInvalidation(transaction, analyticsSource, Date.now(), matchKeys);
          }
        }
      }

      // Preserve each accepted upstream 200 payload as an immutable source
      // version. The current endpoint state may also contain webhook patches;
      // source records retain exactly what TBA returned.
      const sourceVersion = responseState.status === "unavailable"
        ? null
        : createProviderSourceVersion(latest, next, responseState, now);
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
      return { status: next.status, acquired: next.lastFetchedAt !== null, representationChanged, snapshotChanged: next.revision !== latest.revision, snapshotVersion };
    });

    if (result.snapshotChanged) await this.publishSnapshotRevision(result.snapshotVersion);

    if (!options.suppressStatboticsRefresh && result.representationChanged && this.isStatboticsTriggerEndpoint(endpoint)) {
      await this.scheduleStatboticsRefresh(Date.now());
    }
    if (endpoint === TBA_ENDPOINTS.eventTeams(this.eventKey) && result.representationChanged &&
        await this.storage.get<string>("lifecycle:state") === "active") {
      await this.syncTeamActivity(true);
    }

    // A 304 without a retained representation is not a successful refresh.
    // A Statbotics 304 means its representation has not caught up to the TBA
    // change that triggered this bounded refresh. Retry without discarding data.
    return responseState.status !== "failed" && responseState.status !== "unavailable" &&
      result.status !== "failed" && result.status !== "unavailable" && result.acquired &&
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

  private async scheduleStatboticsRefresh(now: number, overrideDelayMs?: number): Promise<void> {
    const endpoint = STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0);
    const configuredDelay = this.env.STATBOTICS_REFRESH_DELAY_MS;
    const delayMs = overrideDelayMs ?? (configuredDelay === undefined ? 5 * 60_000 : Number(configuredDelay));
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
          if (messageType === "match_score") {
            await recordAnalyticsInvalidation(transaction, "tba-event-matches", now, [match.key]);
          }
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

      if (["upcoming_match", "schedule_updated", "starting_comp_level"].includes(messageType)) {
        await recordAnalyticsInvalidation(transaction, "tba-event-matches", now);
      } else if (messageType === "alliance_selection") {
        await recordAnalyticsInvalidation(transaction, "tba-event", now);
        await recordAnalyticsInvalidation(transaction, "tba-event-alliances", now);
        await recordAnalyticsInvalidation(transaction, "tba-team-event-statuses", now);
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
