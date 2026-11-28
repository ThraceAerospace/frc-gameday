import { DurableObjectBase } from "./durable-object-base.ts";
import { TBAApiClient } from "../../../../packages/providers/tba/src/client.ts";
import { TBA_ENDPOINTS } from "../../../../packages/providers/tba/src/endpoints.ts";
import { StatboticsApiClient } from "../../../../packages/providers/statbotics/src/client.ts";
import { STATBOTICS_ENDPOINTS } from "../../../../packages/providers/statbotics/src/endpoints.ts";
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
import { affectedTeamsForChangedMatches } from "./affected-match-teams.ts";
import { createProviderSourceVersion } from "./source-record.ts";
import { validateRuntimeBootstrapBundle } from "./bootstrap.ts";
import type { TBAAward, TBAEliminationAlliance, TBAEvent, TBAEventAdvancementPoints, TBAEventOPRs, TBAEventPredictions, TBAEventRanking, TBAEventTeamStatuses, TBAMatch, TBATeam } from "../../../../packages/providers/tba/src/types.ts";
import type { StatboticsMatch } from "../../../../packages/providers/statbotics/src/types.ts";
import type { EventKey } from "../../../../packages/domain/src/ids.ts";
import type { FieldViewSourceRecordMetadata } from "../../../../packages/domain/src/source-metadata.ts";
import type { FieldViewAnalyticsInputRecord } from "../../../../packages/domain/src/analytics.ts";
import { normalizeFieldViewEventState } from "../../../../packages/domain/src/normalization/event-state.ts";
import { calculateCanonicalMatchAnalytics } from "../../../../packages/analytics/src/canonical-match-analytics.ts";
import {
  mergeAnalyticsInvalidations,
  planAnalyticsInvalidation,
  type AnalyticsInvalidation,
  type AnalyticsSourceKey,
} from "../../../../packages/analytics/src/invalidation.ts";
import { buildFieldViewEventTeamSummaries, calculateFieldViewEventTeamComparisonAnalytics } from "../../../../packages/analytics/src/event-team-comparison-analytics.ts";
import { isEventAnalyticsPublicationCommand } from "./analytics-orchestration-contract.ts";
import type { TeamEventAnalyticsResult } from "./analytics-orchestration-contract.ts";
import type { FieldViewTeamEventState } from "../../../../packages/domain/src/team.ts";

const ENDPOINT_PREFIX = "endpoint:";
const SOURCE_PREFIX = "source:";
const ANALYTICS_DUE_KEY = "analytics:due-at";
const ANALYTICS_ENABLED_KEY = "analytics:enabled";
const ANALYTICS_PUBLICATION_KEY = "analytics:publication";
const ANALYTICS_REVISION_KEY = "analytics:revision";
// Preserve the established invalidation key name across the runtime migration.
const ANALYTICS_INVALIDATION_KEY = "analytics:invalidation";
const TEAM_STATE_REVISION_PREFIX = "team-state-revision:";
const TEAM_EVENT_REVISION_PREFIX = "team-event-revision:";
const EVENT_COMPARISON_INPUT_UPDATED_AT_KEY = "event-team-comparison-input:updated-at";

interface EventStateProjection {
  sourceRevision: number;
  snapshotVersion: number;
  generatedAt: number;
  status: "complete" | "partial" | "failed";
  sourceSignature: string;
  state: ReturnType<typeof normalizeFieldViewEventState>;
}

interface AnalyticsPublication {
  sourceRevision: number;
  calculatedAt: number;
  analyticsRevision?: number;
  matches: Array<{ key: string; analysis?: unknown; flags?: unknown }>;
  eventAnalytics?: unknown;
  /** Revisions of TeamRuntime-owned TeamEventState records consumed by this calculation. */
  teamStateRevisions: Array<{ team_key: string; revision: number | null }>;
}

function endpointStorageKey(endpoint: string): string {
  return `${ENDPOINT_PREFIX}${endpoint}`;
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

export function hasStaleTeamAnalyticsPublication(
  results: TeamEventAnalyticsResult[],
  latestTeamRevisions: Map<string, number>,
  latestTeamEventRevisions: Map<string, number>,
  currentComparisonInputUpdatedAt: number,
): boolean {
  return results.some((result) => {
    const latestTeamRevision = latestTeamRevisions.get(TEAM_STATE_REVISION_PREFIX + result.team_key);
    const latestTeamEventRevision = latestTeamEventRevisions.get(TEAM_EVENT_REVISION_PREFIX + result.team_key);
    return (latestTeamRevision !== undefined && latestTeamRevision > result.team_source_revision) ||
      (latestTeamEventRevision !== undefined && latestTeamEventRevision > result.team_event_revision) ||
      result.comparison_input_updated_at < currentComparisonInputUpdatedAt;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const normalize = (value: string) => value.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((candidate) =>
    candidate.trim() === "*" || normalize(candidate) === normalize(etag));
}

function hashEventSourceSignature(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function eventSnapshotEtag(
  publication: EventStateProjection,
  comparisonInputUpdatedAt: number | undefined,
): string {
  // generatedAt is publication metadata, not representation identity. Including
  // it would invalidate an otherwise identical ETag when a cached publication
  // is rebuilt after a team-only revision or a client reconnects.
  return 'W/"fv-event-snapshot-v1-' + publication.snapshotVersion + '-' +
    publication.sourceRevision + '-' + publication.status + '-' +
    hashEventSourceSignature(publication.sourceSignature) + '-' +
    (comparisonInputUpdatedAt ?? "none") + '"';
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
 * canonical publications. The Worker-level coordinator owns recurring refresh
 * eligibility and dispatch. Network I/O stays outside storage transactions.
 */
export class EventRuntime extends DurableObjectBase {
  private readonly state: DurableObjectStateLike;
  private readonly storage: DurableObjectStateLike["storage"];
  private readonly api: TBAApiClient;
  private readonly statboticsApi: StatboticsApiClient;
  private readonly env: RuntimeEnvironment;
  private eventKey: string;
  private allowedEndpoints: Set<string>;
  private readonly activation: Promise<void>;
  private readonly hydrationMode: "platform-barrier" | "storage-backed";
  private hotProjection: EventStateProjection | undefined;

  constructor(state: DurableObjectStateLike, env: RuntimeEnvironment, eventKey?: string) {
    super(state, env);
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
    this.hydrationMode = state.blockConcurrencyWhile ? "platform-barrier" : "storage-backed";
    // Restore only this object's persisted identity. Provider acquisition and
    // projection construction remain explicit operations.
    this.activation = state.blockConcurrencyWhile
      ? state.blockConcurrencyWhile(async () => {
          const storedKey = await this.storage.get<string>("event-key");
          if (storedKey && !this.eventKey) {
            this.eventKey = storedKey;
            this.allowedEndpoints = new Set(eventResourceEndpoints(storedKey));
          }
        })
      : Promise.resolve();
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

  private async restoreEventKey(request: Request): Promise<boolean> {
    const requested = request.headers.get("X-FieldView-Event-Key");
    const stored = await this.storage.get<string>("event-key");
    const eventKey = stored ?? this.eventKey;
    if (!requested || !eventKey || !/^[a-zA-Z0-9_-]+$/.test(eventKey) || requested !== eventKey) return false;
    if (this.eventKey && this.eventKey !== eventKey) return false;
    this.eventKey = eventKey;
    this.allowedEndpoints = new Set(eventResourceEndpoints(eventKey));
    return true;
  }


  async fetch(request: Request): Promise<Response> {
    await this.activation;
    const url = new URL(request.url);
    const adminAuthorized = Boolean(this.env.RUNTIME_ADMIN_TOKEN) &&
      request.headers.get("Authorization") === "Bearer " + this.env.RUNTIME_ADMIN_TOKEN;
    const publicRead = request.method === "GET" &&
      (url.pathname === "/snapshot" || url.pathname === "/analytics" || url.pathname === "/statbotics-match");
    const publicSubscriptionRead = request.method === "POST" && url.pathname === "/subscriptions";
    const readinessRequest = request.method === "POST" && url.pathname === "/readiness";
    const adminInspectionRead = request.method === "GET" &&
      (url.pathname === "/state" || url.pathname === "/analytics-state" ||
        url.pathname === "/analytics-orchestration-input");
    if (!adminAuthorized && !publicRead) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (publicRead || publicSubscriptionRead || readinessRequest || adminInspectionRead) {
      if (!(await this.restoreEventKey(request))) {
        const storedEventKey = await this.storage.get<string>("event-key");
        if (!storedEventKey) return Response.json({ error: "Event runtime is not registered" }, {
          status: 404, headers: { "Cache-Control": "no-store" },
        });
        return Response.json({ error: "Invalid or mismatched event identity" }, { status: 400 });
      }
    } else if (!(await this.bindEventKey(request))) {
      return Response.json({ error: "Invalid or mismatched event identity" }, { status: 400 });
    }
    // Public reads create only the requested ephemeral projection. Explicit
    // commands own provider-resource writes.
    if (request.method === "POST" && url.pathname === "/bootstrap") {
      const body: unknown = await request.json().catch(() => null);
      const year = Number(this.eventKey.slice(0, 4));
      if (!validateRuntimeBootstrapBundle(body, { kind: "event", key: this.eventKey, year })) {
        return Response.json({ error: "Invalid event bootstrap bundle" }, { status: 400 });
      }
      const allowed = new Set([...this.allowedEndpoints, STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0)]);
      const required = new Set([TBA_ENDPOINTS.event(this.eventKey), TBA_ENDPOINTS.eventTeams(this.eventKey)]);
      if (body.resources.length !== required.size ||
          body.resources.some((resource) => !allowed.has(resource.endpoint) || !required.has(resource.endpoint)) ||
          [...required].some((endpoint) => !body.resources.some((resource) => resource.endpoint === endpoint))) {
        return Response.json({ error: "Event bootstrap must contain exactly the event and participant baseline resources" }, { status: 400 });
      }
      const receipt = await this.storage.transaction(async (tx) => {
        const receiptKey = "bootstrap:accepted:" + year;
        const previous = await tx.get<{ bootstrap_id: string; acquired_at: number; snapshot_revision: number; resource_status: "complete" | "partial" | "failed" }>(receiptKey);
        if (previous?.bootstrap_id === body.bootstrap_id) return { ...previous, duplicate: true };
        if (previous && previous.acquired_at > body.acquired_at) return null;
        const existing = await Promise.all(body.resources.map((resource) => tx.get<EndpointState<unknown>>(endpointStorageKey(resource.endpoint))));
        if (existing.some((resource) => Boolean(resource && (
            (resource.lastFetchedAt !== null && resource.lastFetchedAt > body.acquired_at) ||
            (resource.lastWebhookAt !== null && resource.lastWebhookAt > body.acquired_at)
          )))) return null;
        const effectiveResources: EndpointState<unknown>[] = [];
        for (let index = 0; index < body.resources.length; index += 1) {
          const resource = body.resources[index]!;
          const previous = existing[index];
          const hasLastGood = previous && (previous.lastFetchedAt !== null || previous.lastWebhookAt !== null);
          if ((resource.status === "failed" || resource.status === "unavailable") && hasLastGood) {
            const retained = { ...previous, status: "stale" as const, lastAttemptAt: resource.lastAttemptAt };
            effectiveResources.push(retained);
            await tx.put(endpointStorageKey(resource.endpoint), retained);
          } else {
            effectiveResources.push(resource);
            await tx.put(endpointStorageKey(resource.endpoint), resource);
          }
        }
        const snapshotRevision = (await tx.get<number>("snapshot-revision") ?? 0) + 1;
        await tx.put("snapshot-revision", snapshotRevision);
        const status = effectiveResources.every((resource) => resource.status === "available") ? "complete" as const
          : effectiveResources.some((resource) => resource.lastFetchedAt !== null || resource.lastWebhookAt !== null) ? "partial" as const : "failed" as const;
        const next = { bootstrap_id: body.bootstrap_id, acquired_at: body.acquired_at, snapshot_revision: snapshotRevision, resource_status: status };
        await tx.put(receiptKey, next);
        return { ...next, duplicate: false };
      });
      if (!receipt) return Response.json({ error: "Bootstrap is older than runtime data" }, { status: 409 });
      return Response.json({
        bootstrap_id: receipt.bootstrap_id, accepted: true, duplicate: receipt.duplicate,
        kind: "event", key: this.eventKey, year, snapshot_revision: receipt.snapshot_revision,
        resource_status: receipt.resource_status,
      });
    }

    if (request.method === "POST" && url.pathname === "/subscriptions") {
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || (body.action !== "subscribe" && body.action !== "unsubscribe") ||
          (body.topic !== undefined && body.topic !== "event-state" && body.topic !== "analytics") ||
          (body.generation !== undefined &&
            (!Number.isSafeInteger(body.generation) || (body.generation as number) < 1))) {
        return Response.json({ error: "Expected a valid topic, subscribe or unsubscribe action, and an optional positive generation" }, { status: 400 });
      }
      const topic = body.topic === "analytics" ? "analytics" : "event-state";
      const generationKey = topic === "analytics"
        ? "multiplexer:analytics-registration-generation"
        : "multiplexer:registration-generation";
      const registeredKey = topic === "analytics" ? "multiplexer:analytics" : "multiplexer:shared";
      if (typeof body.generation === "number") {
        const currentGeneration = await this.storage.get<number>(generationKey) ?? 0;
        if (body.generation <= currentGeneration) {
          return Response.json({
            registered: await this.storage.get<boolean>(registeredKey) === true,
            event_key: this.eventKey,
            topic,
            generation: currentGeneration,
            stale: true,
          });
        }
        await this.storage.put(generationKey, body.generation);
      }
      const registered = body.action === "subscribe";
      await this.storage.put(registeredKey, registered);
      return Response.json({
        registered,
        event_key: this.eventKey,
        topic,
        ...(typeof body.generation === "number" ? { generation: body.generation } : {}),
      });
    }

    if (request.method === "POST" && url.pathname === "/readiness") {
      const body: unknown = await request.json().catch(() => null);
      const requireFullHydration = isRecord(body) && body.require_full_hydration === true;
      const sources = await this.storage.list<EndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      const fullEndpoints = [...this.allowedEndpoints,
        STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0)];
      const baselineEndpoints = [TBA_ENDPOINTS.event(this.eventKey), TBA_ENDPOINTS.eventTeams(this.eventKey)];
      const expectedEndpoints = requireFullHydration ? fullEndpoints : baselineEndpoints;
      const validState = expectedEndpoints.every((endpoint) => {
        const source = sources.get(endpointStorageKey(endpoint));
        return Boolean(source && (
          source.lastFetchedAt !== null || source.lastWebhookAt !== null ||
          source.status === "unavailable"
        ));
      });
      const requestedInterval = isRecord(body) ? body.minimumIntervalMs : undefined;
      const minimumIntervalMs = typeof requestedInterval === "number" &&
        Number.isSafeInteger(requestedInterval) && requestedInterval >= 1_000 &&
        requestedInterval <= 24 * 60 * 60_000 ? requestedInterval : 0;
      const now = Date.now();
      const staleSources = expectedEndpoints.filter((endpoint) => {
        const source = sources.get(endpointStorageKey(endpoint));
        const lastAttemptAt = source?.lastAttemptAt ?? source?.lastFetchedAt ?? source?.lastWebhookAt;
        const attemptedRecently = Boolean(source && lastAttemptAt !== null &&
          lastAttemptAt !== undefined && now - lastAttemptAt < minimumIntervalMs);
        return !source ||
          ((source.status === "failed" || source.status === "stale") && !attemptedRecently) ||
          (source.lastFetchedAt === null && source.lastWebhookAt === null &&
            source.status !== "unavailable" && !attemptedRecently) ||
          (!attemptedRecently && source.expiresAt !== null && source.expiresAt <= now);
      });
      const refreshRequired = !validState || staleSources.length > 0;
      const resourceStatuses = expectedEndpoints.map((endpoint) =>
        sources.get(endpointStorageKey(endpoint))?.status ?? "missing");
      const stateStatus = validState
        ? resourceStatuses.some((status) => status === "failed" || status === "stale") ? "stale" : "available"
        : "missing";
      return Response.json({
        event_key: this.eventKey,
        state_valid: validState,
        hydration_scope: requireFullHydration ? "full" : "baseline",
        publication_status: stateStatus,
        stale_sources: staleSources,
        refresh_required: refreshRequired,
        refresh_dispatched: false,
        refresh_completed: false,
        refreshed_endpoints: [],
        failed_endpoints: [],
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "POST" && url.pathname === "/register") {
      return Response.json({ event_key: this.eventKey, registered: true }, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (request.method === "POST" && url.pathname === "/refresh") {
      const body: unknown = await request.json().catch(() => ({}));
      const statboticsEndpoint = STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0);
      const requested = isRecord(body) && Array.isArray(body.endpoints)
        ? body.endpoints
        : [...this.allowedEndpoints, statboticsEndpoint];
      if (!requested.every((endpoint) => typeof endpoint === "string" &&
          (this.allowedEndpoints.has(endpoint) || endpoint === statboticsEndpoint))) {
        return Response.json({ error: "Refresh endpoints must belong to this event" }, { status: 400 });
      }
      // An explicit endpoint list is exact, including the Statbotics resource.
      // Omitting the list requests the complete EventRuntime-owned resource set.
      const refreshEndpoints = [...new Set(requested as string[])];
      const results: Array<{ endpoint: string; success: boolean }> = [];
      const matchesEndpoint = TBA_ENDPOINTS.eventMatches(this.eventKey);
      const previousMatches = refreshEndpoints.includes(matchesEndpoint)
        ? await this.storage.get<EndpointState<unknown>>(endpointStorageKey(matchesEndpoint))
        : undefined;
      const previousRevision = await this.storage.get<number>("snapshot-revision") ?? 0;
      for (const endpoint of refreshEndpoints) {
        results.push({ endpoint, success: await this.pollEndpoint(endpoint) });
      }
      const matchRefresh = results.find((item) => item.endpoint === matchesEndpoint);
      const latestMatches = refreshEndpoints.includes(matchesEndpoint)
        ? await this.storage.get<EndpointState<unknown>>(endpointStorageKey(matchesEndpoint))
        : undefined;
      const affectedTeamKeys = matchRefresh?.success && latestMatches
        ? affectedTeamsForChangedMatches(previousMatches?.providerData, latestMatches.providerData)
        : undefined;
      const currentRevision = await this.storage.get<number>("snapshot-revision") ?? 0;
      const analyticsAffectedTeamKeys = currentRevision !== previousRevision &&
        (affectedTeamKeys === undefined || (Array.isArray(affectedTeamKeys) && affectedTeamKeys.length === 0))
        ? null : affectedTeamKeys;
      // Always refresh the in-memory projection after explicit provider work;
      // a persisted EventState is optional and never gates a fresh read.

      const entries = await this.storage.list<EndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      const endpointResults = results.map((result) => {
        const state = entries.get(endpointStorageKey(result.endpoint)) as
          (EndpointState<unknown> & { lastError?: string | null; lastHttpStatus?: number | null }) | undefined;
        return {
          ...result,
          status: state?.status ?? "unknown",
          http_status: state?.lastHttpStatus ?? null,
          last_error: state?.lastError ?? null,
        };
      });
      // A successful HTTP response from a provider is not the same as a
      // successful refresh operation. Report retryable acquisition failures
      // to the next explicit coordinator dispatch while retaining the last-good publication.
      // Provider 404s remain unavailable (not retryable) because many event
      // resources legitimately do not exist until later in the season.
      const failedEndpoints = endpointResults.filter((result) => !result.success && result.status !== "unavailable");
      const retryable = failedEndpoints.length > 0;
      const responseBody = {
        event_key: this.eventKey,
        requested: refreshEndpoints.length,
        attempted: results.length,
        succeeded: results.filter((result) => result.success).length,
        failed: failedEndpoints.length,
        retryable,
        results: endpointResults,
        failed_endpoints: failedEndpoints.map((result) => result.endpoint),
        ...(analyticsAffectedTeamKeys === undefined ? {} : { affected_team_keys: analyticsAffectedTeamKeys }),
        state: [...entries.values()].map((state) => ({
          endpoint: state.endpoint, status: state.status, revision: state.revision,
          fetched_at: state.lastFetchedAt, attempted_at: state.lastAttemptAt,
          last_error: (state as EndpointState<unknown> & { lastError?: string | null }).lastError ?? null,
        })),
      };
      console.info("[FV][EventRuntime][Refresh] " + JSON.stringify({
        event_key: this.eventKey,
        requested: refreshEndpoints.length,
        succeeded: responseBody.succeeded,
        failed: responseBody.failed,
        retryable,
      }));
      return Response.json(responseBody, {
        status: retryable ? 503 : 200,
        headers: { "Cache-Control": "no-store", ...(retryable ? { "Retry-After": "30" } : {}) },
      });
    }

    if (request.method === "POST" && url.pathname === "/participants") {
      // EventRuntime owns the event-participant provider resource. Coordinators
      // may request readiness, but never call TBA directly for the roster.
      const body: unknown = await request.json().catch(() => null);
      const requestedInterval = isRecord(body) ? body.minimumIntervalMs : undefined;
      const minimumIntervalMs = typeof requestedInterval === "number" &&
        Number.isSafeInteger(requestedInterval) && requestedInterval >= 1_000 &&
        requestedInterval <= 24 * 60 * 60_000 ? requestedInterval : 0;
      const endpoint = TBA_ENDPOINTS.eventTeams(this.eventKey);
      let state = await this.storage.get<EndpointState<TBATeam[]>>(endpointStorageKey(endpoint));
      const attemptedRecently = Boolean(state && state.lastAttemptAt !== null &&
        Date.now() - state.lastAttemptAt < minimumIntervalMs);
      if (!state || state.status !== "available" ||
          (state.lastFetchedAt == null && state.lastWebhookAt == null) ||
          (state.expiresAt !== null && state.expiresAt <= Date.now()) || !Array.isArray(state.data)) {
        if (!attemptedRecently) await this.pollEndpoint(endpoint);
        const refreshed = await this.storage.get<EndpointState<TBATeam[]>>(endpointStorageKey(endpoint));
        if (!refreshed || refreshed.status !== "available" || !Array.isArray(refreshed.data)) {
          return Response.json({ ready: false, status: refreshed?.status ?? "pending", retry_after_ms: attemptedRecently ? minimumIntervalMs : null }, {
            status: 503, headers: { "Cache-Control": "no-store" },
          });
        }
        state = refreshed;
      }
      if (!Array.isArray(state.data)) {
        return Response.json({ ready: false, status: state.status }, {
          status: 503, headers: { "Cache-Control": "no-store" },
        });
      }
      const teamKeys = [...new Set(state.data.map((team) => team?.key).filter((key): key is string =>
        typeof key === "string" && /^frc\d+$/.test(key)))].sort();
      return Response.json({ ready: true, team_keys: teamKeys }, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (request.method === "POST" && url.pathname === "/ingest-resource") {
      const body: unknown = await request.json().catch(() => null);
      const endpoint = isRecord(body) && typeof body.endpoint === "string" ? body.endpoint : null;
      const statboticsEndpoint = STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0);
      if (!endpoint || (!this.allowedEndpoints.has(endpoint) && endpoint !== statboticsEndpoint)) {
        return Response.json({ error: "Resource endpoint is not part of this event" }, { status: 400 });
      }
      const previousRevision = await this.storage.get<number>("snapshot-revision") ?? 0;
      const success = await this.pollEndpoint(endpoint);
      const currentRevision = await this.storage.get<number>("snapshot-revision") ?? 0;

      const state = await this.storage.get<EndpointState<unknown>>(endpointStorageKey(endpoint));
      const diagnostic = state as (EndpointState<unknown> & { lastError?: string | null; lastHttpStatus?: number | null }) | undefined;
      return Response.json({
        endpoint, attempted: true, success,
        status: state?.status ?? "pending",
        revision: state?.revision ?? 0, last_fetched_at: state?.lastFetchedAt ?? null,
        http_status: diagnostic?.lastHttpStatus ?? null, last_error: diagnostic?.lastError ?? null,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "POST" && url.pathname === "/statbotics-refresh") {
      const endpoint = STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0);
      const previousRevision = await this.storage.get<number>("snapshot-revision") ?? 0;
      const success = await this.pollEndpoint(endpoint);
      const currentRevision = await this.storage.get<number>("snapshot-revision") ?? 0;

      const state = await this.storage.get<EndpointState<unknown>>(endpointStorageKey(endpoint));
      return Response.json({
        scheduled: false, attempted: true, success,
        event_key: this.eventKey, endpoint,
        status: state?.status ?? "unknown", revision: state?.revision ?? 0,
        record_count: Array.isArray(state?.providerData) ? state.providerData.length : 0,
        fetched_at: state?.lastFetchedAt ?? null,
        analytics_status: await this.storage.get<string>("analytics:status") ?? "succeeded",
      }, { headers: { "Cache-Control": "no-store" } });
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
      const eventData = payload.message_data.event;
      const matchData = payload.message_data.match;
      const messageEventKey = payload.message_data.event_key ??
        (isRecord(eventData) ? eventData.key : undefined) ??
        (isRecord(matchData) ? matchData.event_key : undefined);
      if (messageEventKey !== this.eventKey) {
        return Response.json({ error: "Webhook event key mismatch" }, { status: 400 });
      }
      if (await this.storage.get<boolean>(ANALYTICS_ENABLED_KEY) !== true) {
        await this.storage.put(ANALYTICS_ENABLED_KEY, true);
      }
      const accepted = await this.applyTbaWebhook(
        webhookId, payload.message_type, payload.message_data, rawPayload,
      );
      return Response.json({ accepted: true, duplicate: !accepted });
    }

    if (request.method === "GET" && url.pathname === "/analytics") {
      const publication = await this.storage.get<AnalyticsPublication>(ANALYTICS_PUBLICATION_KEY);
      if (!publication) return Response.json({ error: "EventAnalytics publication not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
      const revision = await this.storage.get<number>(ANALYTICS_REVISION_KEY) ?? 0;
      const endpointStates = await this.storage.list<EndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      const expectedEndpoints = [...eventResourceEndpoints(this.eventKey), STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0)];
      const currentSourceRevision = expectedEndpoints.reduce((total, endpoint) =>
        total + (endpointStates.get(endpointStorageKey(endpoint))?.revision ?? 0), 0);
      const storedStatus = await this.storage.get<string>("analytics:status") ?? (publication ? "succeeded" : "pending");
      const analyticsStatus = publication && publication.sourceRevision !== currentSourceRevision ? "stale" : storedStatus;
      const comparisonInputUpdatedAt = await this.storage.get<number>(EVENT_COMPARISON_INPUT_UPDATED_AT_KEY);
      const storedEventAnalytics = publication?.eventAnalytics as ReturnType<typeof normalizeFieldViewEventState>["analytics"] | undefined;
      const currentEventAnalytics = storedEventAnalytics?.team_comparison?.input_updated_at === comparisonInputUpdatedAt
        ? storedEventAnalytics
        : storedEventAnalytics ? { ...storedEventAnalytics, team_comparison: undefined } : storedEventAnalytics;
      const currentPublication = publication
        ? { ...publication, ...(currentEventAnalytics === undefined ? {} : { eventAnalytics: currentEventAnalytics }) }
        : null;
      const dueAt = await this.storage.get<number>(ANALYTICS_DUE_KEY) ?? null;
      const pendingInvalidation = await this.storage.get<AnalyticsInvalidation>(ANALYTICS_INVALIDATION_KEY) ?? null;
      const etag = 'W/"fv-analytics-v1-' + revision + '-' + currentSourceRevision + '-' +
        analyticsStatus + '-' + (dueAt ?? "none") + '-' + (pendingInvalidation?.requested_at ?? "none") + '"';
      if (etagMatches(request.headers.get("If-None-Match"), etag)) {
        return new Response(null, { status: 304, headers: {
          ETag: etag, "Cache-Control": "private, no-cache",
        } });
      }
      return Response.json({
        event_key: this.eventKey,
        revision,
        status: analyticsStatus,
        due_at: dueAt,
        calculated_at: publication?.calculatedAt ?? null,
        source_revision: publication?.sourceRevision ?? null,
        pending_invalidation: pendingInvalidation,
        publication: currentPublication,
      }, {
        headers: {
          "X-FieldView-Analytics-Version": String(revision),
          ETag: etag,
          "Cache-Control": "private, no-cache",
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/statbotics-match") {
      // This endpoint reads its own provider resource; it must not depend on an
      // aggregate EventState projection or on unrelated TBA resources.
      const matchKey = url.searchParams.get("match_key");
      if (!matchKey || !/^[a-zA-Z0-9_]+$/.test(matchKey) || !matchKey.startsWith(this.eventKey + "_")) {
        return Response.json({ error: "Invalid or mismatched Statbotics match key" }, { status: 400 });
      }
      const endpoint = STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0);
      const state = await this.storage.get<EndpointState<StatboticsMatch[]>>(endpointStorageKey(endpoint));
      if (!state) return Response.json({ error: "Statbotics match resource not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
      if (state.lastFetchedAt === null || !Array.isArray(state.data)) {
        return Response.json({ available: false, status: state.status }, {
          status: 503, headers: { "Cache-Control": "no-store" },
        });
      }
      const match = state.data.find((item) => item.key === matchKey);
      if (!match) return Response.json({ available: false }, { status: 404, headers: { "Cache-Control": "no-store" } });
      return Response.json(match, { headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "GET" && url.pathname === "/snapshot") {
      const publication = await this.getEventStateProjection();
      if (!publication) return Response.json({ error: "EventState projection unavailable" }, { status: 404, headers: { "Cache-Control": "no-store" } });
      if (!Number.isSafeInteger(publication.snapshotVersion) || !isRecord(publication.state) ||
          publication.state.event_key !== this.eventKey || !isRecord(publication.state.sources)) {
        return Response.json({ error: "EventState projection is invalid" }, { status: 500, headers: { "Cache-Control": "no-store" } });
      }
      const comparisonInputUpdatedAt = await this.storage.get<number>(EVENT_COMPARISON_INPUT_UPDATED_AT_KEY);
      const etag = eventSnapshotEtag(publication, comparisonInputUpdatedAt);
      const sourceStates = await this.storage.list<EndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      const sourceStale = [...eventResourceEndpoints(this.eventKey),
        STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0)]
        .some((endpoint) => {
          const source = sourceStates.get(endpointStorageKey(endpoint));
          return !source || source.status === "failed" || source.status === "stale" ||
            (source.expiresAt !== null && source.expiresAt <= Date.now());
        });
      const publicationStatus = sourceStale ? "stale" : publication.status;
      const headers = {
        "X-FieldView-Snapshot-Version": String(publication.snapshotVersion),
        "X-FieldView-Event-State-Status": publicationStatus,
        "X-FieldView-Team-State-Coverage": "partial",
        ETag: etag,
        "Cache-Control": "private, no-cache",
      };
      if (etagMatches(request.headers.get("If-None-Match"), etag)) {
        return new Response(null, { status: 304, headers });
      }
      const { analytics: _unownedAnalytics, ...eventOwnedState } = publication.state;
      return Response.json(eventOwnedState, { headers });
    }

    if (request.method === "GET" && url.pathname === "/analytics-state") {
      const entries = await this.storage.list<EndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      const expectedEndpoints = [...eventResourceEndpoints(this.eventKey), STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0)];
      const currentSourceRevision = expectedEndpoints.reduce((total, endpoint) =>
        total + (entries.get(endpointStorageKey(endpoint))?.revision ?? 0), 0);
      const publication = await this.storage.get<AnalyticsPublication>(ANALYTICS_PUBLICATION_KEY);
      const eventEndpoints = eventResourceEndpoints(this.eventKey);
      const eventStatePublished = eventEndpoints.slice(0, 2).every((endpoint) => {
        const source = entries.get(endpointStorageKey(endpoint));
        return Boolean(source && (source.lastFetchedAt !== null || source.lastWebhookAt !== null ||
          source.status === "unavailable"));
      });
      return Response.json({
        event_key: this.eventKey,
        event_state_published: eventStatePublished,
        source_revision: currentSourceRevision,
        comparison_input_updated_at: await this.storage.get<number>(EVENT_COMPARISON_INPUT_UPDATED_AT_KEY) ?? null,
        analytics: {
          source_revision: publication?.sourceRevision ?? null,
          revision: await this.storage.get<number>(ANALYTICS_REVISION_KEY) ?? 0,
          status: publication && publication.sourceRevision !== currentSourceRevision
            ? "stale" : await this.storage.get<string>("analytics:status") ?? (publication ? "succeeded" : "pending"),
          due_at: await this.storage.get<number>(ANALYTICS_DUE_KEY) ?? null,
          pending_invalidation: await this.storage.get<AnalyticsInvalidation>(ANALYTICS_INVALIDATION_KEY) ?? null,
        },
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "GET" && url.pathname === "/analytics-orchestration-input") {
      const current = await this.buildEventState(false);
      if (!current.state.event || !Array.isArray(current.state.teams)) {
        return Response.json({ error: "Event analytics inputs are not yet available" }, { status: 409 });
      }
      return Response.json({
        contract_version: 1,
        event_key: this.eventKey,
        event_source_revision: current.sourceRevision,
        comparison_input_updated_at: await this.storage.get<number>(EVENT_COMPARISON_INPUT_UPDATED_AT_KEY) ?? null,
        event_state: current.state,
      }, {
        headers: {
          "X-FieldView-Event-Source-Revision": String(current.sourceRevision),
          "X-FieldView-Snapshot-Version": String(current.version),
          "Cache-Control": "no-store",
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/analytics-orchestration-publication") {
      const body: unknown = await request.json().catch(() => null);
      if (!isEventAnalyticsPublicationCommand(body) || body.event_key !== this.eventKey) {
        return Response.json({ error: "Invalid event analytics publication command" }, { status: 400 });
      }
      const published = await this.recalculateAnalytics(body.team_results, body.event_source_revision);
      if (!published) {
        return Response.json({ error: "Event analytics inputs changed or publication could not be completed" }, { status: 409 });
      }
      return Response.json({
        accepted: true,
        event_key: this.eventKey,
        event_source_revision: body.event_source_revision,
        team_result_count: body.team_results.length,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const entries = await this.storage.list<EndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      const analyticsPublication = await this.storage.get<AnalyticsPublication>(ANALYTICS_PUBLICATION_KEY);
      const eventEndpoints = eventResourceEndpoints(this.eventKey);
      const rosterRecord = entries.get(endpointStorageKey(eventEndpoints[1]));
      const rosterAvailable = Boolean(rosterRecord && (rosterRecord.lastFetchedAt !== null ||
        rosterRecord.lastWebhookAt !== null || rosterRecord.status === "unavailable"));
      const expectedTeamCount = Array.isArray(rosterRecord?.data) ? rosterRecord.data.length : 0;
      const snapshotVersion = await this.storage.get<number>("snapshot-revision") ?? 0;
      const expectedEndpoints = [...eventResourceEndpoints(this.eventKey), STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0)];
      const currentSourceRevision = expectedEndpoints.reduce((total, endpoint) =>
        total + (entries.get(endpointStorageKey(endpoint))?.revision ?? 0), 0);
      // Admin diagnostics must stay local to this EventRuntime. Checking every
      // participant's TeamRuntime here turns one dashboard read into an N+1
      // cross-object fan-out; team-state coverage is owned by TeamRuntime.
      const teamStateCoverageStatus = rosterAvailable ? "not_inspected" : "unavailable";
      const hasStaleSources = expectedEndpoints.some((endpoint) => {
        const source = entries.get(endpointStorageKey(endpoint));
        return !source || source.status === "failed" || source.status === "stale" ||
          (source.expiresAt !== null && source.expiresAt <= Date.now());
      });
      const hasAnyResource = expectedEndpoints.some((endpoint) => entries.has(endpointStorageKey(endpoint)));
      const eventStateStatus = !hasAnyResource ? "missing"
        : hasStaleSources ? "stale" : rosterAvailable ? "available" : "partial";
      const storedAnalyticsStatus = await this.storage.get<string>("analytics:status") ?? (analyticsPublication ? "succeeded" : "pending");
      const analyticsStatus = analyticsPublication && analyticsPublication.sourceRevision !== currentSourceRevision
        ? "stale" : storedAnalyticsStatus;
      return Response.json({
        event_key: this.eventKey,
        source_revision: currentSourceRevision,
        readiness: {
          hydration: this.hydrationMode === "platform-barrier" ? "complete" : "storage-backed",
          hydrated_scope: ["event_identity", "provider_endpoint_records"],
          event_state_projection: {
            available: rosterAvailable,
            hot_cache: Boolean(this.hotProjection),
            status: eventStateStatus,
            version: snapshotVersion,
            source_revision: currentSourceRevision,
          },
          polling_owner: "PollingCoordinatorWorkflow",
          local_poll_tasks: 0,
          last_error: await this.storage.get<string>("analytics:last-error") ?? null,
        },
        event_state: {
          status: eventStateStatus,
          generated_at: null,
          source_revision: currentSourceRevision,
        },
        analytics: {
          revision: await this.storage.get<number>(ANALYTICS_REVISION_KEY) ?? 0,
          due_at: await this.storage.get<number>(ANALYTICS_DUE_KEY) ?? null,
          status: analyticsStatus,
          last_calculated_at: analyticsPublication?.calculatedAt ?? null,
          source_revision: analyticsPublication?.sourceRevision ?? null,
          pending_invalidation: await this.storage.get<AnalyticsInvalidation>(ANALYTICS_INVALIDATION_KEY) ?? null,
          team_state_coverage: { status: teamStateCoverageStatus, expected: expectedTeamCount, observed: null },
          last_error: await this.storage.get<string>("analytics:last-error") ?? null,
        },
        resources: expectedEndpoints.map((endpoint) => {
          const source = entries.get(endpointStorageKey(endpoint));
          return {
            endpoint, status: source?.status ?? "pending",
            last_fetched_at: source?.lastFetchedAt ?? null,
            last_webhook_at: source?.lastWebhookAt ?? null,
            expires_at: source?.expiresAt ?? null,
          };
        }),
        // Polling is coordinator-owned; this runtime has no local task registry.
        polling: [],
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

  private async buildEventState(
    calculateAnalytics = false,
    orchestratedTeamResults?: TeamEventAnalyticsResult[],
    expectedEventSourceRevision?: number,
  ): Promise<{
    version: number;
    sourceRevision: number;
    analyticsInputsComplete?: boolean;
    state: ReturnType<typeof normalizeFieldViewEventState>;
    teamStateRevisions?: Array<{ team_key: string; revision: number | null }>;
  }> {
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

    if (expectedEventSourceRevision !== undefined && state.sourceRevision !== expectedEventSourceRevision) {
      throw new Error("Event source revision changed before analytics publication");
    }
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
      if (orchestratedTeamResults === undefined) {
        throw new Error("Event analytics publication requires Workflow-owned TeamRuntime results");
      }
      const eventAnalyticsState = await calculateCanonicalMatchAnalytics(normalizedState, inputRecords);
      const teamStates = orchestratedTeamResults.map((result) => result.state);
      const teamStateRevisions = orchestratedTeamResults.map((result) => ({
        team_key: result.team_key,
        revision: result.team_event_revision,
      }));
      const expectedTeamCount = normalizedState.teams?.length ?? 0;
      const participantKeys = new Set((normalizedState.teams ?? []).map((team) => team.key));
      if (orchestratedTeamResults.some((result) => !participantKeys.has(result.team_key))) {
        throw new Error("Analytics publication contains a team outside the event roster");
      }
      const comparisonInputUpdatedAt = orchestratedTeamResults[0]?.comparison_input_updated_at ??
        await this.storage.get<number>(EVENT_COMPARISON_INPUT_UPDATED_AT_KEY) ?? null;
      const comparisonTeamRevisions = orchestratedTeamResults.map((result) => ({
        team_key: result.team_key,
        revision: result.team_source_revision,
      }));
      const teamStatesComplete = teamStates.length === expectedTeamCount &&
        teamStates.every((teamState) => teamState.analytics !== undefined && teamState.analytics !== null);
      const teamComparison = calculateFieldViewEventTeamComparisonAnalytics(
        teamStates,
        expectedTeamCount,
        comparisonTeamRevisions,
        teamStateRevisions,
        comparisonInputUpdatedAt,
      );
      const teamSummaries = buildFieldViewEventTeamSummaries(normalizedState, teamStates);
      const eventAnalytics = eventAnalyticsState.analytics
        ? { ...eventAnalyticsState.analytics, team_summaries: teamSummaries, team_comparison: teamComparison }
        : eventAnalyticsState.analytics;
      return {
        version: state.version,
        sourceRevision: state.sourceRevision,
        analyticsInputsComplete: inputRecords.every((input) => input.status === "available") && teamStatesComplete,
        teamStateRevisions,
        state: {
          ...eventAnalyticsState,
          ...(eventAnalytics === undefined ? {} : { analytics: eventAnalytics }),
        },
      };
    }

    const { analytics: _unownedAnalytics, ...eventOwnedState } = normalizedState;
    const storedPublication = await this.storage.get<AnalyticsPublication>(ANALYTICS_PUBLICATION_KEY);
    const publication = storedPublication?.sourceRevision === state.sourceRevision ? storedPublication : undefined;
    if (!publication) return { version: state.version, sourceRevision: state.sourceRevision, state: eventOwnedState };
    const matchAnalytics = new Map(publication.matches.map((match) => [match.key, match]));
    const matches = eventOwnedState.matches === undefined || eventOwnedState.matches === null
      ? eventOwnedState.matches
      : eventOwnedState.matches.map((match) => {
          const published = matchAnalytics.get(match.key);
          return published ? {
            ...match,
            ...(published.analysis === undefined ? {} : { analysis: published.analysis as typeof match.analysis }),
            ...(published.flags === undefined ? {} : { flags: published.flags as typeof match.flags }),
          } : match;
        });
    return {
      version: state.version,
      sourceRevision: state.sourceRevision,
      state: {
        ...eventOwnedState,
        ...(matches === undefined ? {} : { matches }),
      },
    };
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

  private async getEventStateProjection(): Promise<EventStateProjection> {
    // EventState is a derived read model. A previously materialized copy is
    // an optional cache only; provider endpoint records remain authoritative.
    // Reads may hydrate/rebuild this projection in memory, but never persist it.
    const endpoints = [
      ...eventResourceEndpoints(this.eventKey),
      STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0),
    ];
    const [previous, version, resources] = await Promise.all([
      Promise.resolve(this.hotProjection),
      this.storage.get<number>("snapshot-revision").then((value) => value ?? 0),
      Promise.all(endpoints.map((endpoint) =>
        this.storage.get<EndpointState<unknown>>(endpointStorageKey(endpoint)))),
    ]);
    const now = Date.now();
    const sourceSignature = JSON.stringify(resources.map((resource) => resource ? [
      resource.revision, resource.status, resource.lastFetchedAt, resource.lastWebhookAt,
      resource.expiresAt, resource.etag,
      resource.expiresAt !== null && resource.expiresAt <= now,
    ] : null));
    const sourceRevision = resources.reduce((total, resource) => total + (resource?.revision ?? 0), 0);
    if (previous && previous.snapshotVersion === version && previous.sourceRevision === sourceRevision &&
        previous.sourceSignature === sourceSignature &&
        previous.state?.event_key === this.eventKey && isRecord(previous.state.sources)) {
      this.hotProjection = previous;
      return previous;
    }
    const result = await this.buildEventState();
    const acquiredCount = resources.filter((resource) =>
      resource?.lastFetchedAt != null || resource?.lastWebhookAt != null).length;
    const hasIncompleteResource = resources.some((resource) =>
      !resource || resource.status === "unknown" || resource.status === "stale" ||
      resource.status === "failed" || resource.status === "unavailable" ||
      (resource.expiresAt !== null && resource.expiresAt < now));
    const publication: EventStateProjection = {
      sourceRevision: result.sourceRevision,
      snapshotVersion: result.version,
      generatedAt: now,
      sourceSignature,
      status: acquiredCount === endpoints.length && !hasIncompleteResource
        ? "complete" : acquiredCount > 0 ? "partial" : "failed",
      state: result.state,
    };
    this.hotProjection = publication;
    return publication;
  }

  private async recalculateAnalytics(
    orchestratedTeamResults?: TeamEventAnalyticsResult[],
    expectedEventSourceRevision?: number,
  ): Promise<boolean> {
    // Run calculations only from explicit runtime commands, never public reads.
    // If sources change during calculation, discard the result and coalesce
    // another run rather than publishing a mixed-revision analytics payload.
    let calculated: {
      version: number;
      sourceRevision: number;
      analyticsInputsComplete?: boolean;
      state: ReturnType<typeof normalizeFieldViewEventState>;
        teamStateRevisions?: Array<{ team_key: string; revision: number | null }>;
    };
    try {
      calculated = await this.buildEventState(true, orchestratedTeamResults, expectedEventSourceRevision);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (expectedEventSourceRevision !== undefined &&
          detail === "Event source revision changed before analytics publication") return false;
      await this.storage.transaction(async (transaction) => {
        await transaction.put("analytics:status", "failed");
        await transaction.put(ANALYTICS_DUE_KEY, Date.now() + 30_000);
        await transaction.put("analytics:last-error", detail.slice(0, 300));
      });
      return false;
    }
    await this.storage.transaction(async (transaction) => {
      const dueAt = await transaction.get<number>(ANALYTICS_DUE_KEY);
      if (!Number.isSafeInteger(dueAt)) await transaction.put(ANALYTICS_DUE_KEY, Date.now());
      await transaction.put("analytics:status", "running");
    });
    const state = calculated.state;
    const publication: AnalyticsPublication = {
      sourceRevision: calculated.sourceRevision,
      calculatedAt: Date.now(),
      matches: (state.matches ?? []).map((match) => ({
        key: match.key,
        ...(match.analysis === undefined ? {} : { analysis: match.analysis }),
        ...(match.flags === undefined ? {} : { flags: match.flags }),
      })),
      ...(state.analytics === undefined ? {} : { eventAnalytics: state.analytics }),
      teamStateRevisions: calculated.teamStateRevisions ?? [],
    };
    const publishedVersion = await this.storage.transaction(async (transaction) => {
      const currentRevision = await transaction.get<number>("snapshot-revision") ?? 0;
      if (currentRevision !== calculated.version) {
        await transaction.put(ANALYTICS_DUE_KEY, Date.now() + 1_000);
        await transaction.put("analytics:status", "pending");
        return null;
      }
      if (orchestratedTeamResults !== undefined) {
        const latestTeamRevisions = await transaction.list<number>({ prefix: TEAM_STATE_REVISION_PREFIX });
        const latestTeamEventRevisions = await transaction.list<number>({ prefix: TEAM_EVENT_REVISION_PREFIX });
        const currentComparisonInputUpdatedAt =
          await transaction.get<number>(EVENT_COMPARISON_INPUT_UPDATED_AT_KEY) ?? 0;
        const staleTeamInput = hasStaleTeamAnalyticsPublication(
          orchestratedTeamResults,
          latestTeamRevisions,
          latestTeamEventRevisions,
          currentComparisonInputUpdatedAt,
        );
        if (staleTeamInput) {
          await transaction.put(ANALYTICS_DUE_KEY, Date.now() + 1_000);
          await transaction.put("analytics:status", "pending");
            return null;
        }
        if (orchestratedTeamResults.length > 0) {
          await transaction.put(
            EVENT_COMPARISON_INPUT_UPDATED_AT_KEY,
            orchestratedTeamResults[0].comparison_input_updated_at,
          );
        }
        for (const result of orchestratedTeamResults) {
          const key = TEAM_STATE_REVISION_PREFIX + result.team_key;
          const latest = latestTeamRevisions.get(key);
          if (latest === undefined || result.team_source_revision > latest) {
            await transaction.put(key, result.team_source_revision);
          }
          const eventRevisionKey = TEAM_EVENT_REVISION_PREFIX + result.team_key;
          const latestEventRevision = await transaction.get<number>(eventRevisionKey);
          if (latestEventRevision === undefined || result.team_event_revision > latestEventRevision) {
            await transaction.put(eventRevisionKey, result.team_event_revision);
          }
        }
      }
      const analyticsRevision = (await transaction.get<number>(ANALYTICS_REVISION_KEY) ?? 0) + 1;
      publication.analyticsRevision = analyticsRevision;
      await transaction.put(ANALYTICS_REVISION_KEY, analyticsRevision);
      await transaction.put(ANALYTICS_PUBLICATION_KEY, publication);
      await transaction.delete(ANALYTICS_INVALIDATION_KEY);
      const collectionPartial = isRecord(calculated.state.analytics) &&
        isRecord(calculated.state.analytics.collection) &&
        calculated.state.analytics.collection.state === "partial";
      const teamStatesIncomplete = calculated.analyticsInputsComplete === false;
      const analyticsIncomplete = Boolean(teamStatesIncomplete || collectionPartial);
      // Cross-runtime retries belong to EventAnalyticsWorkflow. EventRuntime
      // publishes an explicit partial result instead of maintaining a local retry queue.
      await transaction.delete(ANALYTICS_DUE_KEY);
      await transaction.put("analytics:status", analyticsIncomplete ? "partial" : "succeeded");
      await transaction.delete("analytics:last-error");
      const nextRevision = currentRevision + 1;
      await transaction.put("snapshot-revision", nextRevision);
      return nextRevision;
    });
    if (publishedVersion !== null) {
      const analyticsRevision = await this.storage.get<number>(ANALYTICS_REVISION_KEY) ?? 0;
      await this.publishSnapshotRevision(publishedVersion);
      await this.publishAnalyticsRevision(analyticsRevision);
      return true;
    }
    return false;
  }

  private async publishAnalyticsRevision(version: number): Promise<void> {
    if (!this.env.MULTIPLEXER || !this.env.RUNTIME_ADMIN_TOKEN ||
        await this.storage.get<boolean>("multiplexer:analytics") !== true) return;
    const [publication, storedStatus, endpointStates] = await Promise.all([
      this.storage.get<AnalyticsPublication>(ANALYTICS_PUBLICATION_KEY),
      this.storage.get<string>("analytics:status"),
      this.storage.list<EndpointState<unknown>>({ prefix: ENDPOINT_PREFIX }),
    ]);
    const currentSourceRevision = [...eventResourceEndpoints(this.eventKey),
      STATBOTICS_ENDPOINTS.matches({ event: this.eventKey }, 1000, 0)]
      .reduce((total, endpoint) => total +
        (endpointStates.get(endpointStorageKey(endpoint))?.revision ?? 0), 0);
    const status = publication && publication.sourceRevision !== currentSourceRevision
      ? "stale" : storedStatus ?? (publication ? "succeeded" : "pending");
    const comparisonInputUpdatedAt = await this.storage.get<number>(EVENT_COMPARISON_INPUT_UPDATED_AT_KEY);
    const storedEventAnalytics = publication?.eventAnalytics as ReturnType<typeof normalizeFieldViewEventState>["analytics"] | undefined;
    const currentEventAnalytics = storedEventAnalytics?.team_comparison?.input_updated_at === comparisonInputUpdatedAt
      ? storedEventAnalytics
      : storedEventAnalytics ? { ...storedEventAnalytics, team_comparison: undefined } : storedEventAnalytics;
    const currentPublication = publication
      ? { ...publication, ...(currentEventAnalytics === undefined ? {} : { eventAnalytics: currentEventAnalytics }) }
      : null;
    const dueAt = await this.storage.get<number>(ANALYTICS_DUE_KEY) ?? null;
    const pendingInvalidation = await this.storage.get<AnalyticsInvalidation>(ANALYTICS_INVALIDATION_KEY) ?? null;
    const etag = 'W/"fv-analytics-v1-' + version + '-' + currentSourceRevision + '-' +
      status + '-' + (dueAt ?? "none") + '-' + (pendingInvalidation?.requested_at ?? "none") + '"';
    const data = {
      event_key: this.eventKey,
      revision: version,
      status,
      due_at: dueAt,
      calculated_at: publication?.calculatedAt ?? null,
      source_revision: publication?.sourceRevision ?? null,
      pending_invalidation: pendingInvalidation,
      publication: currentPublication,
    };
    const multiplexer = this.env.MULTIPLEXER.get(this.env.MULTIPLEXER.idFromName("shared"));
    await multiplexer.fetch(new Request("https://fieldview-multiplexer/internal/notify", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        protocol: 1,
        schema_version: 1,
        topic: "analytics",
        resource: "event-analytics",
        change: "snapshot",
        event_key: this.eventKey,
        version,
        data,
        etag,
      }),
    })).catch(() => undefined);
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
      | { status: "unavailable"; httpStatus: number }
      | { status: "failed"; reason: string; httpStatus?: number };

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
          httpStatus: response.status,
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

    if (responseState.status === "not-modified") {
      const latest = await this.storage.get<EndpointState<unknown>>(endpointStorageKey(endpoint));
      return !isStatboticsEndpoint && latest?.lastFetchedAt !== null && latest?.lastFetchedAt !== undefined;
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
          : responseState.status === "unavailable" ? responseState.httpStatus
            : responseState.status === "failed" ? responseState.httpStatus ?? null : null,
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

    // A 304 without a retained representation is not a successful refresh.
    // A Statbotics 304 means its representation has not caught up to the TBA
    // change that triggered this bounded refresh. Retry without discarding data.
    return responseState.status !== "failed" && responseState.status !== "unavailable" &&
      result.status !== "failed" && result.status !== "unavailable" && result.acquired;
  }

  private authoritativeRefetchDelayMs(): number {
    const configured = this.env.TBA_AUTHORITATIVE_REFETCH_DELAY_MS;
    const delay = configured === undefined ? 65_000 : Number(configured);
    if (!Number.isSafeInteger(delay) || delay < 0) {
      throw new Error("TBA_AUTHORITATIVE_REFETCH_DELAY_MS must be a non-negative integer");
    }
    return delay;
  }

  private async applyTbaWebhook(
    webhookId: string,
    messageType: string,
    messageData: Record<string, unknown>,
    rawPayload: string,
  ): Promise<boolean> {
    const eventKey = this.eventKey;
    const matchesEndpoint = TBA_ENDPOINTS.eventMatches(eventKey);
    const now = Date.now();

    const result = await this.storage.transaction(async (transaction) => {
      const webhookKey = "webhook:" + webhookId;
      const snapshotRevisionBefore = await transaction.get<number>("snapshot-revision") ?? 0;
      if (await transaction.get(webhookKey) !== undefined) {
        return {
          accepted: false,
          snapshotVersion: null as number | null,
          snapshotRevisionBefore,
          snapshotRevisionAfter: snapshotRevisionBefore,
        };
      }
      await transaction.put(webhookKey, { receivedAt: now, messageType, rawPayload });

      if (messageType === "match_score" || messageType === "match_video") {
        const match = messageData.match;
        if (isRecord(match) && typeof match.key === "string" && match.event_key === eventKey) {
          const key = endpointStorageKey(matchesEndpoint);
          const current = await transaction.get<EndpointState<unknown>>(key) ??
            createEndpointState<unknown>(matchesEndpoint);
          const next = applyWebhookUpdate(current, match, now,
            (latest, update) => reconcileWebhookEndpoint(matchesEndpoint, latest, update));
          const changed = next.revision !== current.revision;
          if (changed) {
            await transaction.put(key, next);
            if (messageType === "match_score") {
              await recordAnalyticsInvalidation(transaction, "tba-event-matches", now, [match.key]);
            }
            const snapshotRevision = await transaction.get<number>("snapshot-revision") ?? 0;
            await transaction.put("snapshot-revision", snapshotRevision + 1);
          }
        }
      } else if (
        messageType === "upcoming_match" ||
        messageType === "schedule_updated" ||
        messageType === "starting_comp_level"
      ) {
      } else if (messageType === "alliance_selection") {
      } else if (messageType === "awards_posted") {
      }

      if (["upcoming_match", "schedule_updated", "starting_comp_level"].includes(messageType)) {
        await recordAnalyticsInvalidation(transaction, "tba-event-matches", now);
      } else if (messageType === "alliance_selection") {
        await recordAnalyticsInvalidation(transaction, "tba-event", now);
        await recordAnalyticsInvalidation(transaction, "tba-event-alliances", now);
        await recordAnalyticsInvalidation(transaction, "tba-team-event-statuses", now);
      }
      const snapshotRevisionAfter = await transaction.get<number>("snapshot-revision") ?? snapshotRevisionBefore;
      return {
        accepted: true,
        snapshotVersion: snapshotRevisionAfter !== snapshotRevisionBefore &&
          (messageType === "match_score" || messageType === "match_video")
          ? snapshotRevisionAfter
          : null,
        snapshotRevisionBefore,
        snapshotRevisionAfter,
      };
    });

    const match = isRecord(messageData.match) ? messageData.match : null;
    console.info("[FV][EventRuntime][TBAWebhook] " + JSON.stringify({
      event_key: eventKey,
      webhook_id: webhookId,
      message_type: messageType,
      ...(match && typeof match.key === "string" ? { match_key: match.key } : {}),
      accepted: result.accepted,
      duplicate: !result.accepted,
      snapshot_revision_before: result.snapshotRevisionBefore,
      snapshot_revision_after: result.snapshotRevisionAfter,
      snapshot_revision_changed: result.snapshotRevisionAfter !== result.snapshotRevisionBefore,
    }));

    if (result.snapshotVersion !== null) await this.publishSnapshotRevision(result.snapshotVersion);
    return result.accepted;
  }

  private async publishSnapshotRevision(version: number): Promise<void> {
    // Provider writes publish only a revision invalidation. The normalized
    // EventState is assembled on demand by the subsequent /snapshot read.
    const notice = {
      protocol: 1,
      schema_version: 1,
      topic: "event-state",
      resource: "event-snapshot",
      change: "snapshot",
      event_key: this.eventKey,
      version,
    };
    if (await this.storage.get<boolean>("multiplexer:shared") !== true || !this.env.MULTIPLEXER) return;
    const multiplexer = this.env.MULTIPLEXER.get(this.env.MULTIPLEXER.idFromName("shared"));
    await multiplexer.fetch(new Request("https://fieldview-multiplexer/internal/notify", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(notice),
    })).catch(() => undefined);

    // Surface pending/stale analytics metadata immediately, even before the
    // next calculation publishes a higher analytics revision.
    const analyticsStatus = await this.storage.get<string>("analytics:status");
    if (analyticsStatus === "pending" || analyticsStatus === "stale") {
      await this.publishAnalyticsRevision(
        await this.storage.get<number>(ANALYTICS_REVISION_KEY) ?? 0,
      );
    }
  }


}
