import { TBAApiClient } from "../../../packages/providers/tba/src/client.ts";
import { TBA_ENDPOINTS } from "../../../packages/providers/tba/src/endpoints.ts";
import { STATBOTICS_ENDPOINTS } from "../../../packages/providers/statbotics/src/endpoints.ts";
import { eventResourceEndpoints } from "./event-runtime.ts";
import { teamResourceEndpoints } from "./team-runtime.ts";
import { normalizeFieldViewEvent } from "../../../packages/domain/src/normalization/event.ts";
import { normalizeFieldViewTeam } from "../../../packages/domain/src/normalization/team.ts";
import type { FieldViewTeam } from "../../../packages/domain/src/team.ts";
import type { TBAEvent, TBATeam } from "../../../packages/providers/tba/src/types.ts";
import type { DurableObjectStateLike, RuntimeEnvironment } from "./cloudflare.ts";

const DISCOVERY_PREFIX = "discovery:";
const TEAM_DISCOVERY_PREFIX = "team-discovery:";
const ADMIN_DISCOVERY_PREFIX = "admin-discovery:";
const ADMIN_TEAM_DISCOVERY_PREFIX = "admin-team-discovery:";

export interface EventPollingPolicy {
  discoveryIntervalMs: number;
  upcomingIntervalMs: number;
  activeIntervalMs: number;
  completedRetentionMs: number;
}

export const DEFAULT_EVENT_POLLING_POLICY: EventPollingPolicy = {
  discoveryIntervalMs: 60 * 60_000,
  upcomingIntervalMs: 30 * 60_000,
  activeIntervalMs: 5 * 60_000,
  completedRetentionMs: 24 * 60 * 60_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configured(value: string | number | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000) {
    throw new Error(name + " must be an integer of at least 1000 milliseconds");
  }
  return parsed;
}

export function eventPollingPolicy(env: RuntimeEnvironment): EventPollingPolicy {
  return {
    discoveryIntervalMs: configured(env.EVENT_DISCOVERY_INTERVAL_MS, DEFAULT_EVENT_POLLING_POLICY.discoveryIntervalMs, "EVENT_DISCOVERY_INTERVAL_MS"),
    upcomingIntervalMs: configured(env.EVENT_UPCOMING_INTERVAL_MS, DEFAULT_EVENT_POLLING_POLICY.upcomingIntervalMs, "EVENT_UPCOMING_INTERVAL_MS"),
    activeIntervalMs: configured(env.EVENT_ACTIVE_INTERVAL_MS, DEFAULT_EVENT_POLLING_POLICY.activeIntervalMs, "EVENT_ACTIVE_INTERVAL_MS"),
    completedRetentionMs: configured(env.EVENT_COMPLETED_RETENTION_MS, DEFAULT_EVENT_POLLING_POLICY.completedRetentionMs, "EVENT_COMPLETED_RETENTION_MS"),
  };
}

export type EventLifecycle = "upcoming" | "active" | "completed" | "expired";

export interface EventLifecycleDecision {
  lifecycle: EventLifecycle;
  completedUntil: number | null;
}

function parseDateOnly(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  if (new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return { year, month, day };
}

function nextDateOnly(value: string): string | null {
  const parts = parseDateOnly(value);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + 86_400_000)
    .toISOString().slice(0, 10);
}

/** Convert local midnight in an IANA timezone to its UTC instant. */
function zonedMidnight(value: string, timeZone: string): number | null {
  const date = parseDateOnly(value);
  if (!date || !timeZone) return null;
  const target = Date.UTC(date.year, date.month - 1, date.day);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    let candidate = target;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const values = new Map(formatter.formatToParts(new Date(candidate))
        .map((part) => [part.type, part.value]));
      const represented = Date.UTC(
        Number(values.get("year")),
        Number(values.get("month")) - 1,
        Number(values.get("day")),
        Number(values.get("hour")),
        Number(values.get("minute")),
        Number(values.get("second")),
      );
      const adjustment = target - represented;
      if (adjustment === 0) return candidate;
      candidate += adjustment;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * TBA event dates are local calendar dates. Classify their boundaries in the
 * event's IANA timezone, including DST transitions; the end date is inclusive.
 */
export function classifyEventLifecycle(
  event: Pick<TBAEvent, "start_date" | "end_date" | "timezone">,
  now: number,
  policy: EventPollingPolicy,
): EventLifecycleDecision | null {
  const endExclusiveDate = nextDateOnly(event.end_date);
  if (!endExclusiveDate || typeof event.timezone !== "string" || event.timezone.length === 0) return null;
  const start = zonedMidnight(event.start_date, event.timezone);
  const endExclusive = zonedMidnight(endExclusiveDate, event.timezone);
  if (start === null || endExclusive === null || endExclusive <= start) return null;
  const end = endExclusive - 1;
  if (now < start) return { lifecycle: "upcoming", completedUntil: null };
  if (now <= end) return { lifecycle: "active", completedUntil: null };
  const completedUntil = end + policy.completedRetentionMs;
  return now < completedUntil
    ? { lifecycle: "completed", completedUntil }
    : { lifecycle: "expired", completedUntil };
}

interface DiscoveryCache {
  etag: string | null;
  complete?: boolean;
  events: TBAEvent[];
  /** Retrieval time of the retained payload version. */
  updatedAt: number;
  /** Most recent successful 200/304 validation of that payload. */
  checkedAt?: number;
}

interface ProviderRequestLease { leaseId: string; owner: string; endpoint: string; expiresAt: number; }

interface SeasonIngestJob {
  year: number;
  runGeneration: number;
  eventDiscoveryUpdatedAt: number;
  teamDiscoveryUpdatedAt: number;
  status: "running" | "paused" | "completed" | "completed_with_errors" | "cancelled";
  phase: "teams" | "events" | "complete";
  teamKeys: string[];
  eventKeys: string[];
  teamResourceCount: number;
  eventResourceCount: number;
  teamSnapshotRevision: number;
  teamCursor: number;
  teamResourceCursor: number;
  eventCursor: number;
  eventResourceCursor: number;
  resourceAttempts: number;
  nextDueAt?: number;
  counts: {
    teams_complete: number; teams_partial: number; teams_failed: number;
    event_state_complete: number; event_state_partial: number; event_state_missing: number; event_state_failed: number;
    event_analytics_succeeded: number; event_analytics_partial: number;
    event_analytics_waiting: number; event_analytics_missing: number; event_analytics_failed: number;
    event_cohort_complete: number; event_cohort_partial: number; event_cohort_discovering: number; event_cohort_missing: number;
    requests_attempted: number; requests_succeeded: number; requests_failed: number; requests_retried: number;
    requests_skipped: number; requests_unavailable: number; requests_deferred: number;
  };
  recentErrors: Array<{ kind: "team" | "event"; key: string; detail: string; at: number }>;
  startedAt: number;
  updatedAt: number;
}

const seasonIngestKey = (year: number) => "admin:season-ingest:" + year;
const seasonIngestHistoryPrefix = (year: number) => "admin:season-ingest-history:" + year + ":";
const SEASON_INGEST_BOOKKEEPING_DELAY_MS = 100;
const seasonIngestSummary = (job: SeasonIngestJob) => ({
  year: job.year, run_generation: job.runGeneration, event_discovery_updated_at: job.eventDiscoveryUpdatedAt,
  team_discovery_updated_at: job.teamDiscoveryUpdatedAt, status: job.status, phase: job.phase,
  team_cursor: job.teamCursor, team_total: job.teamKeys.length,
  team_resource_cursor: job.teamResourceCursor, team_resources_per_team: job.teamResourceCount,
  event_cursor: job.eventCursor, event_total: job.eventKeys.length,
  event_resource_cursor: job.eventResourceCursor, event_resources_per_event: job.eventResourceCount,
  team_snapshot_revision: job.teamSnapshotRevision,
  next_due_at: job.nextDueAt ?? null,
  counts: job.counts, recent_errors: job.recentErrors,
  started_at: job.startedAt, updated_at: job.updatedAt,
});

interface TeamDiscoveryCache {
  /** Page-zero ETag retained for existing public provenance fields. */
  etag: string | null;
  /** One ETag and payload per TBA page; TBA pages contain at most 500 teams. */
  pageEtags?: Record<string, string | null>;
  pageCount?: number;
  teamCount?: number;
  teamKeys?: string[];
  /** Legacy single-value cache shape, read only during migration. */
  teams?: TBATeam[];
  complete?: boolean;
  updatedAt: number;
  checkedAt?: number;
}

interface EventTeamSeedJob {
  eventKey: string; year: number; status: "running" | "completed" | "completed_with_errors";
  stage: "seed" | "wait"; teamKeys: string[]; cursor: number; activeTeamKey: string | null;
  teamAttempts: number; seededTeams: number; failedTeams: number; historicalEventsScheduled: number;
  errors: Array<{ team_key: string; detail: string; at: number }>;
  startedAt: number; updatedAt: number; nextDueAt: number;
}
const eventTeamSeedKey = (eventKey: string) => "admin:event-team-seed:" + eventKey;

export class EventScheduler {
  private readonly storage: DurableObjectStateLike["storage"];
  private readonly api: TBAApiClient;
  private readonly env: RuntimeEnvironment;

  constructor(state: DurableObjectStateLike, env: RuntimeEnvironment) {
    this.storage = state.storage;
    this.env = env;
    this.api = new TBAApiClient({
      apiKey: env.TBA_API_KEY,
      ...(env.fetcher ? { fetch: env.fetcher } : {}),
    });
  }

  private providerRequestInterval(): number {
    const value = this.env.PROVIDER_REQUEST_INTERVAL_MS;
    const interval = value === undefined ? 1_000 : Number(value);
    if (!Number.isSafeInteger(interval) || interval < 100) {
      throw new Error("PROVIDER_REQUEST_INTERVAL_MS must be an integer of at least 100");
    }
    return interval;
  }

  /** Scheduler-owned discovery requests use the same lease as EventRuntime and TeamRuntime. */
  private async requestWithProviderGate(endpoint: string, request: () => Promise<Response>): Promise<Response> {
    const interval = this.providerRequestInterval();
    while (true) {
      const now = Date.now();
      const permit = await this.storage.transaction(async (tx) => {
        const current = await tx.get<ProviderRequestLease>("provider-gate:lease");
        const nextAt = await tx.get<number>("provider-gate:next-at") ?? 0;
        if (current && current.expiresAt > now) {
          return { granted: false as const, retryAt: Math.min(current.expiresAt, now + interval) };
        }
        if (nextAt > now) return { granted: false as const, retryAt: nextAt };
        const leaseId = crypto.randomUUID();
        await tx.put("provider-gate:lease", {
          leaseId, owner: "scheduler:discovery", endpoint, expiresAt: now + 60_000,
        } satisfies ProviderRequestLease);
        return { granted: true as const, leaseId };
      });
      if (!permit.granted) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.max(10, permit.retryAt - Date.now())));
        continue;
      }
      try {
        return await request();
      } finally {
        await this.storage.transaction(async (tx) => {
          const current = await tx.get<ProviderRequestLease>("provider-gate:lease");
          if (!current || current.leaseId !== permit.leaseId) return;
          await tx.delete("provider-gate:lease");
          await tx.put("provider-gate:next-at", Date.now() + interval);
        });
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/events") {
      const year = Number(url.searchParams.get("year"));
      if (!Number.isSafeInteger(year) || year < 1992 || year > 2200) {
        return Response.json({ error: "Invalid discovery year" }, { status: 400 });
      }
      const cached = await this.storage.get<DiscoveryCache>(DISCOVERY_PREFIX + year);
      if (!cached) return Response.json({ error: "Event discovery cache is not ready" }, { status: 503 });
      const retrievedAt = new Date(cached.updatedAt).toISOString();
      const checkedAt = cached.checkedAt ?? cached.updatedAt;
      const sourceStatus = Date.now() - checkedAt > eventPollingPolicy(this.env).discoveryIntervalMs * 2
        ? "stale" as const
        : "available" as const;
      const events = cached.events.map((event) => normalizeFieldViewEvent(event, {
        tba_event: {
          status: sourceStatus,
          retrieved_at: retrievedAt,
          ...(cached.etag === null ? {} : { validator: cached.etag }),
        },
      }));
      return Response.json(
        { year, events, updatedAt: cached.updatedAt, checkedAt },
        {
          headers: {
            "Cache-Control": "public, max-age=300, stale-while-revalidate=300",
            ...(cached.etag === null ? {} : { ETag: cached.etag }),
          },
        },
      );
    }

    if (request.method === "GET" && url.pathname === "/teams") {
      const year = Number(url.searchParams.get("year"));
      if (!Number.isSafeInteger(year) || year < 1992 || year > 2200) {
        return Response.json({ error: "Invalid team discovery year" }, { status: 400 });
      }
      const cached = await this.storage.get<TeamDiscoveryCache>(TEAM_DISCOVERY_PREFIX + year);
      const discoveredTeams = await this.readDiscoveredTeams(year, TEAM_DISCOVERY_PREFIX);
      if (!cached?.complete || !discoveredTeams) return Response.json({ error: "Complete team discovery cache is not ready" }, { status: 503 });
      const retrievedAt = new Date(cached.updatedAt).toISOString();
      const checkedAt = cached.checkedAt ?? cached.updatedAt;
      const sourceStatus = Date.now() - checkedAt > eventPollingPolicy(this.env).discoveryIntervalMs * 2
        ? "stale" as const
        : "available" as const;
      const teams: FieldViewTeam[] = discoveredTeams.map((team) => normalizeFieldViewTeam(team, {
        tba_teams: {
          status: sourceStatus,
          retrieved_at: retrievedAt,
          ...(cached.etag === null ? {} : { validator: cached.etag }),
        },
      }));
      return Response.json(
        { year, teams, updatedAt: cached.updatedAt, checkedAt },
        {
          headers: {
            "Cache-Control": "public, max-age=300, stale-while-revalidate=300",
            ...(cached.etag === null ? {} : { ETag: cached.etag }),
          },
        },
      );
    }

    const authorized = Boolean(this.env.RUNTIME_ADMIN_TOKEN) &&
      request.headers.get("Authorization") === "Bearer " + this.env.RUNTIME_ADMIN_TOKEN;
    if (!authorized) return Response.json({ error: "Unauthorized" }, { status: 401 });

    if (request.method === "POST" && url.pathname === "/provider-request/acquire") {
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Invalid provider request lease" }, { status: 400 });
      const value = body as Record<string, unknown>;
      if (typeof value.owner !== "string" || value.owner.length > 120 ||
          typeof value.endpoint !== "string" || value.endpoint.length > 500) {
        return Response.json({ error: "Provider request owner and endpoint are required" }, { status: 400 });
      }
      const now = Date.now();
      const intervalValue = this.env.PROVIDER_REQUEST_INTERVAL_MS;
      const interval = intervalValue === undefined ? 1_000 : Number(intervalValue);
      if (!Number.isSafeInteger(interval) || interval < 100) return Response.json({ error: "PROVIDER_REQUEST_INTERVAL_MS must be an integer of at least 100" }, { status: 500 });
      const result = await this.storage.transaction(async (tx) => {
        const current = await tx.get<ProviderRequestLease>("provider-gate:lease");
        const nextAt = await tx.get<number>("provider-gate:next-at") ?? 0;
        if (current && current.expiresAt > now) return { granted: false, retryAt: Math.min(current.expiresAt, now + interval) };
        if (nextAt > now) return { granted: false, retryAt: nextAt };
        const leaseId = crypto.randomUUID();
        await tx.put("provider-gate:lease", { leaseId, owner: value.owner as string, endpoint: value.endpoint as string, expiresAt: now + 60_000 } satisfies ProviderRequestLease);
        return { granted: true, leaseId };
      });
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "POST" && url.pathname === "/provider-request/release") {
      const body: unknown = await request.json().catch(() => null);
      const leaseId = body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).lease_id : null;
      if (typeof leaseId !== "string") return Response.json({ error: "A provider request lease id is required" }, { status: 400 });
      const intervalValue = this.env.PROVIDER_REQUEST_INTERVAL_MS;
      const interval = intervalValue === undefined ? 1_000 : Number(intervalValue);
      const released = await this.storage.transaction(async (tx) => {
        const current = await tx.get<ProviderRequestLease>("provider-gate:lease");
        if (!current || current.leaseId !== leaseId) return false;
        await tx.delete("provider-gate:lease");
        await tx.put("provider-gate:next-at", Date.now() + interval);
        return true;
      });
      return Response.json({ released }, { headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "POST" && url.pathname === "/register") {
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Invalid registration" }, { status: 400 });
      const value = body as Record<string, unknown>;
      const kind = value.kind, key = value.key;
      if ((kind !== "event" && kind !== "team") || typeof key !== "string" || !/^[a-zA-Z0-9_-]+$/.test(key)) {
        return Response.json({ error: "Invalid registration" }, { status: 400 });
      }
      const storageKey = kind === "event" ? "registry:events" : "registry:teams";
      const current = await this.storage.get<string[]>(storageKey) ?? [];
      if (!current.includes(key)) await this.storage.put(storageKey, [...current, key].sort());
      if (kind === "event") {
        const runtimeKeys = await this.storage.get<string[]>("registry:runtime-events") ?? [];
        if (!runtimeKeys.includes(key)) await this.storage.put("registry:runtime-events", [...runtimeKeys, key].sort());
      }
      return Response.json({ registered: true });
    }

    if (request.method === "POST" && url.pathname === "/admin/discover-year") {
      const activeJobs = await this.storage.list<SeasonIngestJob>({ prefix: "admin:season-ingest:" });
      if ([...activeJobs.values()].some((job) => job.status === "running" || job.status === "paused")) {
        return Response.json({ error: "Resume, cancel, or complete the active season-ingest job before refreshing discovery." }, { status: 409 });
      }
      const year = Number(url.searchParams.get("year"));
      if (!Number.isSafeInteger(year) || year < 1992 || year > 2200) {
        return Response.json({ error: "Invalid discovery year" }, { status: 400 });
      }
      try {
        await this.discoverEvents(year);
        const teamDiscovery = await this.discoverTeams(year, ADMIN_TEAM_DISCOVERY_PREFIX);
        const eventDiscovery = await this.storage.get<DiscoveryCache>(ADMIN_DISCOVERY_PREFIX + year);
        return Response.json({
          discovered: true,
          complete: eventDiscovery?.complete === true && teamDiscovery.requestCount > 0,
          year,
          events: eventDiscovery?.events.length ?? 0,
          teams: teamDiscovery.teamCount,
          team_pages: teamDiscovery.pageCount,
          provider_requests: 1 + teamDiscovery.requestCount,
        });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
      }
    }

    if (url.pathname === "/admin/event-team-seed" && request.method === "GET") {
      const eventKey = url.searchParams.get("event_key") ?? "";
      if (!/^[a-zA-Z0-9_-]+$/.test(eventKey)) return Response.json({ error: "Invalid event key" }, { status: 400 });
      const job = await this.storage.get<EventTeamSeedJob>(eventTeamSeedKey(eventKey));
      return Response.json(job ?? { event_key: eventKey, status: "not_started" }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/admin/event-team-seed" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || typeof body.event_key !== "string" || !/^[a-zA-Z0-9_-]+$/.test(body.event_key)) return Response.json({ error: "A valid event_key is required" }, { status: 400 });
      const eventKey = body.event_key, year = Number(body.year);
      if (!Number.isSafeInteger(year) || year < 1992 || year > 2200 || !eventKey.startsWith(String(year))) return Response.json({ error: "The event key and season year must match" }, { status: 400 });
      if (!this.env.TEAM_RUNTIME || !this.env.EVENT_RUNTIME) return Response.json({ error: "TeamRuntime and EventRuntime must be bound" }, { status: 503 });
      const seasonJobs = await this.storage.list<SeasonIngestJob>({ prefix: "admin:season-ingest:" });
      if ([...seasonJobs.values()].some((job) => job.status === "running" || job.status === "paused")) return Response.json({ error: "Pause or complete full-season ingestion before starting event team seeding." }, { status: 409 });
      const current = await this.storage.get<EventTeamSeedJob>(eventTeamSeedKey(eventKey));
      if (current?.status === "running") return Response.json(current, { status: 202 });
      const endpoint = TBA_ENDPOINTS.eventTeams(eventKey);
      const response = await this.requestWithProviderGate(endpoint, () => this.api.request(endpoint));
      if (!response.ok) return Response.json({ error: "Unable to retrieve event participants (HTTP " + response.status + ")" }, { status: 502 });
      const participants = await response.json() as TBATeam[];
      if (!Array.isArray(participants)) return Response.json({ error: "TBA event participants response was not an array" }, { status: 502 });
      const teamKeys = [...new Set(participants.map((team) => team.key).filter((key): key is string => typeof key === "string" && /^frc\d+$/.test(key)))].sort();
      if (teamKeys.length === 0) return Response.json({ error: "No valid participant teams were returned for this event" }, { status: 404 });
      const now = Date.now();
      const job: EventTeamSeedJob = {
        eventKey, year, status: "running", stage: "seed", teamKeys, cursor: 0, activeTeamKey: null,
        teamAttempts: 0, seededTeams: 0, failedTeams: 0, historicalEventsScheduled: 0,
        errors: [], startedAt: now, updatedAt: now, nextDueAt: now,
      };
      await this.storage.put(eventTeamSeedKey(eventKey), job);
      await this.storage.setAlarm(now);
      return Response.json(job, { status: 202, headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/admin/season-ingest" && request.method === "GET") {
      const year = Number(url.searchParams.get("year"));
      if (!Number.isSafeInteger(year) || year < 1992 || year > 2200) return Response.json({ error: "Invalid season year" }, { status: 400 });
      const job = await this.storage.get<SeasonIngestJob>(seasonIngestKey(year));
      const history = await this.storage.list<SeasonIngestJob>({ prefix: seasonIngestHistoryPrefix(year) });
      return Response.json({
        ...(job ? seasonIngestSummary(job) : { year, status: "not_started" }),
        history_count: history.size,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/admin/season-ingest" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Invalid season-ingest request" }, { status: 400 });
      const value = body as Record<string, unknown>;
      const year = Number(value.year), action = value.action;
      if (!Number.isSafeInteger(year) || year < 1992 || year > 2200 ||
          !["preview", "start", "pause", "resume", "cancel"].includes(String(action))) {
        return Response.json({ error: "Expected a valid year and preview, start, pause, resume, or cancel action" }, { status: 400 });
      }
      const key = seasonIngestKey(year);
      let job = await this.storage.get<SeasonIngestJob>(key);
      if (action === "preview") {
        const events = await this.storage.get<DiscoveryCache>(ADMIN_DISCOVERY_PREFIX + year);
        const teams = await this.storage.get<TeamDiscoveryCache>(ADMIN_TEAM_DISCOVERY_PREFIX + year);
        const eventKeys = events?.events.map((item) => item.key).filter((item): item is string =>
          typeof item === "string" && /^[a-zA-Z0-9_-]+$/.test(item)) ?? [];
        const teamKeys = (teams?.teamKeys ?? []).filter((teamKey) => /^frc\d+$/.test(teamKey));
        const runtimeReady = Boolean(this.env.TEAM_RUNTIME && this.env.EVENT_RUNTIME && this.env.RUNTIME_ADMIN_TOKEN && this.env.TBA_API_KEY);
        const discoveryReady = events?.complete === true && teams?.complete === true && eventKeys.length > 0 && teamKeys.length > 0;
        const ready = discoveryReady && runtimeReady;
        const eventResourceCount = eventKeys[0] ? eventResourceEndpoints(eventKeys[0]).length + 1 : 0;
        const teamResourceCount = teamKeys[0] ? teamResourceEndpoints(teamKeys[0], year).length : 0;
        const plannedRequests = eventKeys.length * eventResourceCount + teamKeys.length * teamResourceCount;
        const intervalValue = this.env.PROVIDER_REQUEST_INTERVAL_MS;
        const requestIntervalMs = intervalValue === undefined ? 1_000 : Number(intervalValue);
        return Response.json({
          year, ready, runtime_ready: runtimeReady,
          ready_reason: !discoveryReady ? "Complete event and paginated team discovery first." :
            !runtimeReady ? "TEAM_RUNTIME, EVENT_RUNTIME, RUNTIME_ADMIN_TOKEN, and TBA_API_KEY must be configured." : null,
          events: eventKeys.length, teams: teamKeys.length,
          team_pages: teams?.pageCount ?? 0, event_resources_per_event: eventResourceCount,
          team_resources_per_team: teamResourceCount, planned_resource_requests: plannedRequests,
          request_interval_ms: requestIntervalMs,
          estimated_minimum_duration_ms: plannedRequests * requestIntervalMs,
          estimate_note: "Baseline assumes one provider request per configured resource. Fresh cached resources are skipped with a 100 ms bookkeeping step; retries and normal live polling may add time or requests.",
          existing_job: job ? seasonIngestSummary(job) : null,
          history_count: (await this.storage.list<SeasonIngestJob>({ prefix: seasonIngestHistoryPrefix(year) })).size,
          requires_explicit_confirmation: true,
        }, { headers: { "Cache-Control": "no-store" } });
      }
      if (action === "start") {
        if (!this.env.TEAM_RUNTIME || !this.env.EVENT_RUNTIME || !this.env.RUNTIME_ADMIN_TOKEN || !this.env.TBA_API_KEY) {
          return Response.json({ error: "Season ingestion requires TEAM_RUNTIME, EVENT_RUNTIME, RUNTIME_ADMIN_TOKEN, and TBA_API_KEY bindings." }, { status: 409 });
        }
        if (value.confirm !== true) return Response.json({ error: "Explicit confirmation is required to start season ingestion" }, { status: 400 });
        if (job?.status === "running" || job?.status === "paused") return Response.json({ error: "A season-ingest job already exists in an active or paused state. Resume or cancel it first.", job: seasonIngestSummary(job) }, { status: 409 });
        const events = await this.storage.get<DiscoveryCache>(ADMIN_DISCOVERY_PREFIX + year);
        const teams = await this.storage.get<TeamDiscoveryCache>(ADMIN_TEAM_DISCOVERY_PREFIX + year);
        if (events?.complete !== true || teams?.complete !== true || !teams.teamKeys?.length) {
          return Response.json({ error: "Complete event discovery and paginated team discovery before starting ingestion" }, { status: 409 });
        }
        const eventKeys = [...new Set(events.events.map((event) => event.key).filter((eventKey): eventKey is string => typeof eventKey === "string" && /^[a-zA-Z0-9_-]+$/.test(eventKey)))].sort();
        const teamKeys = [...new Set((teams.teamKeys ?? []).filter((teamKey) => /^frc\d+$/.test(teamKey)))].sort();
        if (eventKeys.length === 0 || teamKeys.length === 0) return Response.json({ error: "Discovered season inventory is empty or invalid" }, { status: 409 });
        if (job && (job.status === "completed" || job.status === "cancelled")) {
          await this.storage.put(seasonIngestHistoryPrefix(year) + job.startedAt, job);
        }
        const now = Date.now();
        const teamResourceCount = teamResourceEndpoints(teamKeys[0], year).length;
        const eventResourceCount = eventResourceEndpoints(eventKeys[0]).length + 1;
        job = {
          year, runGeneration: now, eventDiscoveryUpdatedAt: events.updatedAt, teamDiscoveryUpdatedAt: teams.updatedAt,
          status: "running", phase: "teams", teamKeys, eventKeys, teamResourceCount, eventResourceCount, teamSnapshotRevision: 0,
          teamCursor: 0, teamResourceCursor: 0, eventCursor: 0, eventResourceCursor: 0, resourceAttempts: 0,
          counts: {
            teams_complete: 0, teams_partial: 0, teams_failed: 0,
            event_state_complete: 0, event_state_partial: 0, event_state_missing: 0, event_state_failed: 0,
            event_analytics_succeeded: 0, event_analytics_partial: 0,
            event_analytics_waiting: 0, event_analytics_missing: 0, event_analytics_failed: 0,
            event_cohort_complete: 0, event_cohort_partial: 0, event_cohort_discovering: 0, event_cohort_missing: 0,
            requests_attempted: 0, requests_succeeded: 0, requests_failed: 0, requests_retried: 0,
            requests_skipped: 0, requests_unavailable: 0, requests_deferred: 0,
          },
          recentErrors: [], startedAt: now, updatedAt: now,
        };
        await this.storage.put(key, job);
        await this.storage.setAlarm(now + 1_000);
        return Response.json(seasonIngestSummary(job));
      }
      if (!job) return Response.json({ error: "No season-ingest job exists for this year" }, { status: 404 });
      if (action === "pause") {
        if (job.status === "running") job.status = "paused";
      } else if (action === "resume") {
        if (job.status !== "paused" && job.status !== "completed_with_errors") return Response.json({ error: "Only a paused or completed-with-errors job can resume" }, { status: 409 });
        const currentEvents = await this.storage.get<DiscoveryCache>(ADMIN_DISCOVERY_PREFIX + year);
        const currentTeams = await this.storage.get<TeamDiscoveryCache>(ADMIN_TEAM_DISCOVERY_PREFIX + year);
        if (currentEvents?.updatedAt !== job.eventDiscoveryUpdatedAt ||
            currentTeams?.updatedAt !== job.teamDiscoveryUpdatedAt ||
            teamResourceEndpoints(job.teamKeys[0] ?? "", year).length !== job.teamResourceCount ||
            eventResourceEndpoints(job.eventKeys[0] ?? "").length + 1 !== job.eventResourceCount) {
          return Response.json({ error: "The pinned discovery or resource inventory changed. Cancel this job and start a new run from a fresh preview." }, { status: 409 });
        }
        if (job.status === "completed_with_errors") {
          await this.storage.put(seasonIngestHistoryPrefix(year) + job.startedAt, job);
          job.teamCursor = 0;
          job.teamResourceCursor = 0;
          job.teamSnapshotRevision = 0;
          job.eventCursor = 0;
          job.eventResourceCursor = 0;
          job.resourceAttempts = 0;
          delete job.nextDueAt;
          job.phase = "teams";
          job.counts = {
            teams_complete: 0, teams_partial: 0, teams_failed: 0,
            event_state_complete: 0, event_state_partial: 0, event_state_missing: 0, event_state_failed: 0,
            event_analytics_succeeded: 0, event_analytics_partial: 0,
            event_analytics_waiting: 0, event_analytics_missing: 0, event_analytics_failed: 0,
            event_cohort_complete: 0, event_cohort_partial: 0, event_cohort_discovering: 0, event_cohort_missing: 0,
            requests_attempted: 0, requests_succeeded: 0, requests_failed: 0, requests_retried: 0,
            requests_skipped: 0, requests_unavailable: 0, requests_deferred: 0,
          };
          job.recentErrors = [];
          job.startedAt = Date.now();
        }
        job.runGeneration = Date.now();
        job.status = "running";
        await this.storage.setAlarm(Date.now() + 1_000);
      } else if (action === "cancel") {
        job.status = "cancelled";
      }
      job.updatedAt = Date.now();
      await this.storage.put(key, job);
      if (job.status !== "running" && await this.storage.get<boolean>("scheduler:enabled") !== true) await this.storage.deleteAlarm();
      return Response.json(seasonIngestSummary(job));
    }

    if (request.method === "GET" && url.pathname === "/admin/inventory") {
      const kind = url.searchParams.get("kind");
      const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const cursor = Number(url.searchParams.get("cursor") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      if ((kind !== "event" && kind !== "team") ||
          !Number.isSafeInteger(cursor) || cursor < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return Response.json({ error: "Invalid inventory query" }, { status: 400 });
      }
      const year = Number(url.searchParams.get("year") ?? new Date().getUTCFullYear());
      if (!Number.isSafeInteger(year) || year < 1992 || year > 2200) {
        return Response.json({ error: "Invalid inventory season year" }, { status: 400 });
      }
      const storageKey = kind === "event" ? "registry:events" : "registry:teams";
      const registered = await this.storage.get<string[]>(storageKey) ?? [];
      const discovery = kind === "event"
        ? (await this.storage.get<DiscoveryCache>(ADMIN_DISCOVERY_PREFIX + year) ??
          await this.storage.get<DiscoveryCache>(DISCOVERY_PREFIX + year))
        : (await this.storage.get<TeamDiscoveryCache>(ADMIN_TEAM_DISCOVERY_PREFIX + year) ??
          await this.storage.get<TeamDiscoveryCache>(TEAM_DISCOVERY_PREFIX + year));
      const discoveredKeys = kind === "event"
        ? (discovery as DiscoveryCache | undefined)?.events.map((item) => item.key) ?? []
        : (discovery as TeamDiscoveryCache | undefined)?.teamKeys ?? [];
      const keys = [...new Set([...registered, ...discoveredKeys])]
        .filter((key) => key.toLowerCase().includes(query)).sort();
      return Response.json({
        kind, year, query, total: keys.length, cursor,
        discovery_ready: discovery !== undefined && (kind === "event" || (discovery as TeamDiscoveryCache).complete === true),
        next_cursor: cursor + limit < keys.length ? cursor + limit : null,
        keys: keys.slice(cursor, cursor + limit),
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "GET" && url.pathname === "/admin/entity") {
      const kind = url.searchParams.get("kind");
      const requestedKey = url.searchParams.get("key") ?? "";
      if ((kind !== "event" && kind !== "team") || !/^[a-zA-Z0-9_-]+$/.test(requestedKey)) {
        return Response.json({ error: "Invalid entity lookup" }, { status: 400 });
      }
      const key = kind === "team" && /^\d+$/.test(requestedKey) ? "frc" + requestedKey : requestedKey;
      const year = Number(url.searchParams.get("year") ?? new Date().getUTCFullYear());
      if (!Number.isSafeInteger(year) || year < 1992 || year > 2200) {
        return Response.json({ error: "Invalid entity season year" }, { status: 400 });
      }
      const registryKey = kind === "event" ? "registry:events" : "registry:teams";
      const registered = await this.storage.get<string[]>(registryKey) ?? [];
      const discovery = kind === "event"
        ? (await this.storage.get<DiscoveryCache>(ADMIN_DISCOVERY_PREFIX + year) ??
          await this.storage.get<DiscoveryCache>(DISCOVERY_PREFIX + year))
        : (await this.storage.get<TeamDiscoveryCache>(ADMIN_TEAM_DISCOVERY_PREFIX + year) ??
          await this.storage.get<TeamDiscoveryCache>(TEAM_DISCOVERY_PREFIX + year));
      const discovered = kind === "event"
        ? (discovery as DiscoveryCache | undefined)?.events.some((item) => item.key === key) ?? false
        : (discovery as TeamDiscoveryCache | undefined)?.teamKeys?.includes(key) ?? false;
      if (!registered.includes(key) && !discovered) return Response.json({ error: "Entity is not registered or discovered for this season" }, { status: 404 });
      try {
        if (kind === "event") {
          const stub = this.env.EVENT_RUNTIME.get(this.env.EVENT_RUNTIME.idFromName(key));
          const response = await stub.fetch(new Request("https://event-runtime/state", {
            headers: { Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Event-Key": key },
          }));
          return new Response(response.body, { status: response.status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } });
        }
        if (!this.env.TEAM_RUNTIME) return Response.json({ error: "Team runtime is not bound" }, { status: 503 });
        const stub = this.env.TEAM_RUNTIME.get(this.env.TEAM_RUNTIME.idFromName(key));
        const response = await stub.fetch(new Request("https://team-runtime/state", {
          headers: { Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Team-Key": key },
        }));
        return new Response(response.body, { status: response.status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
      }
    }

    if (url.pathname === "/admin/coverage-audit" && request.method === "GET") {
      const year = Number(url.searchParams.get("year"));
      if (!Number.isSafeInteger(year) || year < 1992 || year > 2200) return Response.json({ error: "Invalid audit year" }, { status: 400 });
      const eventDiscoveryReady = (await this.storage.get<DiscoveryCache>(ADMIN_DISCOVERY_PREFIX + year) ??
        await this.storage.get<DiscoveryCache>(DISCOVERY_PREFIX + year)) !== undefined;
      const teamDiscoveryReady = (await this.storage.get<TeamDiscoveryCache>(ADMIN_TEAM_DISCOVERY_PREFIX + year) ??
        await this.storage.get<TeamDiscoveryCache>(TEAM_DISCOVERY_PREFIX + year))?.complete === true;
      const teamDiscovery = await this.storage.get<TeamDiscoveryCache>(ADMIN_TEAM_DISCOVERY_PREFIX + year) ??
        await this.storage.get<TeamDiscoveryCache>(TEAM_DISCOVERY_PREFIX + year);
      const discoveryReady = eventDiscoveryReady && teamDiscoveryReady && teamDiscovery?.complete === true && (teamDiscovery.teamCount ?? teamDiscovery.teamKeys?.length ?? teamDiscovery.teams?.length ?? 0) > 0;
      const eventDiscovery = await this.storage.get<DiscoveryCache>(ADMIN_DISCOVERY_PREFIX + year) ??
        await this.storage.get<DiscoveryCache>(DISCOVERY_PREFIX + year);
      const audit = await this.storage.get<{
        year: number; status: string; started_at: number; updated_at: number; cursor: number;
        event_discovery_updated_at?: number; team_discovery_updated_at?: number;
        event_keys: string[]; team_keys: string[];
        counts: { events_total: number; events_happened: number; events_active: number; events_upcoming: number; events_invalid_dates: number; teams_total: number; team_pages: number; event_runtime_missing: number; team_runtime_missing: number; event_state_complete: number; event_state_partial: number; event_state_stale: number; event_state_missing: number; event_state_failed: number; event_analytics_succeeded: number; event_analytics_partial: number; event_analytics_stale: number; event_analytics_waiting: number; event_analytics_missing: number; event_analytics_failed: number; event_cohort_complete: number; event_cohort_partial: number; event_cohort_discovering: number; event_cohort_missing: number; team_snapshot_complete: number; team_snapshot_partial: number; team_snapshot_missing: number; team_snapshot_failed: number; event_resources_incomplete: number; team_resources_incomplete: number; read_errors: number };
      }>("admin:coverage-audit:" + year);
      if (!audit) return Response.json({ year, status: "not_started", discovery_ready: discoveryReady }, { headers: { "Cache-Control": "no-store" } });
      const snapshotChanged = !discoveryReady ||
        audit.event_discovery_updated_at !== eventDiscovery?.updatedAt ||
        audit.team_discovery_updated_at !== teamDiscovery?.updatedAt;
      const status = snapshotChanged ? "stale" : audit.status;
      const total = audit.event_keys.length + audit.team_keys.length;
      return Response.json({
        year: audit.year, status, discovery_ready: discoveryReady, started_at: audit.started_at, updated_at: audit.updated_at,
        cursor: audit.cursor, processed: audit.cursor, total, remaining: Math.max(0, total - audit.cursor), counts: audit.counts,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/admin/coverage-audit" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Invalid coverage audit request" }, { status: 400 });
      const value = body as Record<string, unknown>;
      const year = Number(value.year);
      const action = value.action;
      if (!Number.isSafeInteger(year) || year < 1992 || year > 2200 || !["start", "continue"].includes(String(action))) {
        return Response.json({ error: "Expected a valid year and start or continue action" }, { status: 400 });
      }
      const storageKey = "admin:coverage-audit:" + year;
      let audit = await this.storage.get<{
        year: number; status: string; started_at: number; updated_at: number;
        event_discovery_updated_at?: number; team_discovery_updated_at?: number;
        event_keys: string[]; team_keys: string[]; cursor: number;
        counts: { events_total: number; teams_total: number; team_pages: number; event_runtime_missing: number; team_runtime_missing: number; event_state_complete: number; event_state_partial: number; event_state_stale: number; event_state_missing: number; event_state_failed: number; event_analytics_succeeded: number; event_analytics_partial: number; event_analytics_stale: number; event_analytics_waiting: number; event_analytics_missing: number; event_analytics_failed: number; event_cohort_complete: number; event_cohort_partial: number; event_cohort_discovering: number; event_cohort_missing: number; team_snapshot_complete: number; team_snapshot_partial: number; team_snapshot_missing: number; team_snapshot_failed: number; event_resources_incomplete: number; team_resources_incomplete: number; read_errors: number };
      }>(storageKey);
      if (action === "start") {
        const eventDiscovery = await this.storage.get<DiscoveryCache>(ADMIN_DISCOVERY_PREFIX + year) ??
          await this.storage.get<DiscoveryCache>(DISCOVERY_PREFIX + year);
        const teamDiscovery = await this.storage.get<TeamDiscoveryCache>(ADMIN_TEAM_DISCOVERY_PREFIX + year) ??
          await this.storage.get<TeamDiscoveryCache>(TEAM_DISCOVERY_PREFIX + year);
        if (!eventDiscovery || !teamDiscovery || teamDiscovery.complete !== true || (teamDiscovery.teamCount ?? teamDiscovery.teamKeys?.length ?? teamDiscovery.teams?.length ?? 0) === 0) return Response.json({ error: "Run complete paginated season discovery before starting the full coverage audit." }, { status: 409 });
        const eventKeys = [...new Set(eventDiscovery.events.map((event) => event.key).filter((key) => typeof key === "string"))].sort();
        const teamKeys = [...new Set(teamDiscovery.teamKeys ?? teamDiscovery.teams?.map((team) => team.key).filter((key) => typeof key === "string") ?? [])].sort();
        const eventCounts = { events_happened: 0, events_active: 0, events_upcoming: 0, events_invalid_dates: 0 };
        for (const event of eventDiscovery.events) {
          const lifecycle = classifyEventLifecycle(event, Date.now(), DEFAULT_EVENT_POLLING_POLICY)?.lifecycle;
          if (lifecycle === "completed" || lifecycle === "expired") eventCounts.events_happened += 1;
          else if (lifecycle === "active") eventCounts.events_active += 1;
          else if (lifecycle === "upcoming") eventCounts.events_upcoming += 1;
          else eventCounts.events_invalid_dates += 1;
        }
        audit = {
          year, status: "running", started_at: Date.now(), updated_at: Date.now(),
          event_discovery_updated_at: eventDiscovery.updatedAt,
          team_discovery_updated_at: teamDiscovery.updatedAt,
          event_keys: eventKeys, team_keys: teamKeys, cursor: 0,
          counts: { events_total: eventKeys.length, ...eventCounts, teams_total: teamKeys.length, team_pages: teamDiscovery.pageCount ?? 0, event_runtime_missing: 0, team_runtime_missing: 0, event_state_complete: 0, event_state_partial: 0, event_state_stale: 0, event_state_missing: 0, event_state_failed: 0, event_analytics_succeeded: 0, event_analytics_partial: 0, event_analytics_stale: 0, event_analytics_waiting: 0, event_analytics_missing: 0, event_analytics_failed: 0, event_cohort_complete: 0, event_cohort_partial: 0, event_cohort_discovering: 0, event_cohort_missing: 0, team_snapshot_complete: 0, team_snapshot_partial: 0, team_snapshot_missing: 0, team_snapshot_failed: 0, event_resources_incomplete: 0, team_resources_incomplete: 0, read_errors: 0 },
        };
        await this.storage.put(storageKey, audit);
      }
      if (!audit || audit.status !== "running") return Response.json(audit ?? { error: "Coverage audit has not been started" }, { status: 409 });
      const all = [...audit.event_keys.map((key) => ({ kind: "event" as const, key })), ...audit.team_keys.map((key) => ({ kind: "team" as const, key }))];
      const registeredEvents = new Set([
        ...(await this.storage.get<string[]>("registry:runtime-events") ?? []),
        ...(await this.storage.get<string[]>("scheduler:event-keys") ?? []),
      ]);
      const registeredTeams = new Set(await this.storage.get<string[]>("registry:teams") ?? []);
      const batch = all.slice(audit.cursor, audit.cursor + 20);
      for (const item of batch) {
        try {
          const isEvent = item.kind === "event";
          // Avoid instantiating thousands of empty Durable Objects merely to inspect missing state.
          if (isEvent && !registeredEvents.has(item.key)) {
            audit.counts.event_runtime_missing += 1;
            audit.counts.event_state_missing += 1;
            audit.counts.event_analytics_missing += 1;
            audit.counts.event_cohort_missing += 1;
            continue;
          }
          if (!isEvent && !registeredTeams.has(item.key)) {
            audit.counts.team_runtime_missing += 1;
            audit.counts.team_snapshot_missing += 1;
            continue;
          }
          if (!isEvent && !this.env.TEAM_RUNTIME) {
            audit.counts.team_runtime_missing += 1;
            audit.counts.team_snapshot_missing += 1;
            continue;
          }
          const namespace = isEvent ? this.env.EVENT_RUNTIME : this.env.TEAM_RUNTIME!;
          const stub = namespace.get(namespace.idFromName(item.key));
          const response = await stub.fetch(new Request(isEvent ? "https://event-runtime/state" : "https://team-runtime/state", {
            headers: {
              Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
              [isEvent ? "X-FieldView-Event-Key" : "X-FieldView-Team-Key"]: item.key,
            },
          }));
          if (!response.ok) {
            if (isEvent) {
              audit.counts.event_runtime_missing += 1;
              audit.counts.event_state_missing += 1;
              audit.counts.event_analytics_missing += 1;
              audit.counts.event_cohort_missing += 1;
            } else {
              audit.counts.team_runtime_missing += 1;
              audit.counts.team_snapshot_missing += 1;
            }
            continue;
          }
          const state = await response.json() as {
            endpoints?: Record<string, { lastFetchedAt?: number | null; last_fetched_at?: number | null; lastWebhookAt?: number | null; last_webhook_at?: number | null; expiresAt?: number | null; expires_at?: number | null; status?: string }> |
              Array<{ lastFetchedAt?: number | null; last_fetched_at?: number | null; lastWebhookAt?: number | null; last_webhook_at?: number | null; expiresAt?: number | null; expires_at?: number | null; status?: string }>;
            analytics?: { status?: string; cohort_status?: string | null };
            event_state?: { status?: string; generated_at?: number | null; source_revision?: number | null };
          };
          const endpointStates = Array.isArray(state.endpoints) ? state.endpoints : Object.values(state.endpoints ?? {});
          const acquiredResources = endpointStates.filter((resource) =>
            resource.lastFetchedAt != null || resource.last_fetched_at != null || resource.lastWebhookAt != null || resource.last_webhook_at != null).length;
          const incompleteResources = endpointStates.filter((resource) =>
            resource.status === "failed" || resource.status === "unavailable" || resource.status === "stale" ||
            ((resource.expiresAt ?? resource.expires_at) != null && (resource.expiresAt ?? resource.expires_at)! < Date.now())).length;
          if (isEvent) {
            if (acquiredResources < 13 || incompleteResources > 0) audit.counts.event_resources_incomplete += 1;
            const eventStateStatus = state.event_state?.status ?? "missing";
            if (eventStateStatus === "complete") audit.counts.event_state_complete += 1;
            else if (eventStateStatus === "partial") audit.counts.event_state_partial += 1;
            else if (eventStateStatus === "stale") audit.counts.event_state_stale += 1;
            else if (eventStateStatus === "failed") audit.counts.event_state_failed += 1;
            else audit.counts.event_state_missing += 1;
            const analyticsStatus = state.analytics?.status ?? "missing";
            if (analyticsStatus === "succeeded") audit.counts.event_analytics_succeeded += 1;
            else if (analyticsStatus === "partial") audit.counts.event_analytics_partial += 1;
            else if (analyticsStatus === "stale") audit.counts.event_analytics_stale += 1;
            else if (analyticsStatus === "waiting-for-cohort") audit.counts.event_analytics_waiting += 1;
            else if (analyticsStatus === "failed") audit.counts.event_analytics_failed += 1;
            else audit.counts.event_analytics_missing += 1;
            const cohortStatus = state.analytics?.cohort_status ??
              (analyticsStatus === "waiting-for-cohort" ? "discovering" : "missing");
            if (cohortStatus === "complete") audit.counts.event_cohort_complete += 1;
            else if (cohortStatus === "partial") audit.counts.event_cohort_partial += 1;
            else if (cohortStatus === "discovering") audit.counts.event_cohort_discovering += 1;
            else audit.counts.event_cohort_missing += 1;
          } else {
            if (acquiredResources >= 7 && incompleteResources === 0) audit.counts.team_snapshot_complete += 1;
            else if (acquiredResources > 0) audit.counts.team_snapshot_partial += 1;
            else audit.counts.team_snapshot_failed += 1;
            if (acquiredResources < 7 || incompleteResources > 0) audit.counts.team_resources_incomplete += 1;
          }
        } catch {
          audit.counts.read_errors += 1;
          if (item.kind === "event") {
            audit.counts.event_runtime_missing += 1;
            audit.counts.event_state_missing += 1;
            audit.counts.event_analytics_missing += 1;
            audit.counts.event_cohort_missing += 1;
          } else {
            audit.counts.team_runtime_missing += 1;
            audit.counts.team_snapshot_missing += 1;
          }
        }
      }
      audit.cursor += batch.length;
      audit.updated_at = Date.now();
      if (audit.cursor >= all.length) audit.status = "completed";
      await this.storage.put(storageKey, audit);
      const { event_keys: _eventKeys, team_keys: _teamKeys, ...summary } = audit;
      return Response.json({ ...summary, processed: audit.cursor, total: all.length, remaining: Math.max(0, all.length - audit.cursor) }, { headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "GET" && url.pathname === "/admin/overview") {
      const eventKeys = [...new Set([
        ...(await this.storage.get<string[]>("registry:events") ?? []),
        ...(await this.storage.get<string[]>("scheduler:event-keys") ?? []),
      ])].sort();
      const teamKeys = [...new Set(await this.storage.get<string[]>("registry:teams") ?? [])].sort();
      const cap = 250;
      const events = await Promise.all(eventKeys.slice(0, cap).map(async (key) => {
        try {
          const stub = this.env.EVENT_RUNTIME.get(this.env.EVENT_RUNTIME.idFromName(key));
          const response = await stub.fetch(new Request("https://event-runtime/state", {
            headers: { Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Event-Key": key },
          }));
          return { key, status: response.status, state: response.ok ? await response.json() : null };
        } catch (error) { return { key, status: 0, error: error instanceof Error ? error.message : String(error) }; }
      }));
      const teams = await Promise.all(teamKeys.slice(0, cap).map(async (key) => {
        try {
          if (!this.env.TEAM_RUNTIME) return { key, status: 503, error: "Team runtime is not bound" };
          const stub = this.env.TEAM_RUNTIME.get(this.env.TEAM_RUNTIME.idFromName(key));
          const response = await stub.fetch(new Request("https://team-runtime/state", {
            headers: { Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Team-Key": key },
          }));
          return { key, status: response.status, state: response.ok ? await response.json() : null };
        } catch (error) { return { key, status: 0, error: error instanceof Error ? error.message : String(error) }; }
      }));
      let multiplexer: unknown = null;
      if (this.env.MULTIPLEXER) {
        try {
          const stub = this.env.MULTIPLEXER.get(this.env.MULTIPLEXER.idFromName("shared"));
          const response = await stub.fetch(new Request("https://fieldview-multiplexer/state", {
            headers: { Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN },
          }));
          multiplexer = response.ok ? await response.json() : { status: response.status };
        } catch (error) { multiplexer = { error: error instanceof Error ? error.message : String(error) }; }
      }
      return Response.json({
        generated_at: new Date().toISOString(),
        scheduler: {
          enabled: await this.storage.get<boolean>("scheduler:enabled") ?? false,
          last_run_at: await this.storage.get<number>("scheduler:last-run-at") ?? null,
          next_alarm_at: await this.storage.getAlarm?.() ?? null,
          last_error: await this.storage.get<string>("scheduler:last-error") ?? null,
          team_discovery_error: await this.storage.get<string>("scheduler:team-discovery-error") ?? null,
        },
        events, teams, multiplexer,
        truncated: eventKeys.length > cap || teamKeys.length > cap,
        inventory: { events: eventKeys.length, teams: teamKeys.length },
      });
    }

    if (request.method === "POST" && url.pathname === "/run") {
      const activeJobs = await this.storage.list<SeasonIngestJob>({ prefix: "admin:season-ingest:" });
      if ([...activeJobs.values()].some((job) => job.status === "running" || job.status === "paused")) {
        return Response.json({ error: "Pause/resume or cancel the season-ingest job before running discovery manually." }, { status: 409 });
      }
      const policy = eventPollingPolicy(this.env);
      const errors: string[] = [];
      try {
        await this.discoverAndSchedule(policy);
        await this.storage.delete("scheduler:last-error");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        errors.push("Event discovery: " + detail);
        await this.storage.put("scheduler:last-error", detail);
      }
      try {
        await this.discoverTeams(new Date().getUTCFullYear());
        await this.storage.delete("scheduler:team-discovery-error");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        errors.push("Team discovery: " + detail);
        await this.storage.put("scheduler:team-discovery-error", detail);
      }
      await this.storage.put("scheduler:last-run-at", Date.now());
      if (await this.storage.get<boolean>("scheduler:enabled") === true) {
        await this.storage.setAlarm(Date.now() + policy.discoveryIntervalMs);
      }
      return Response.json({ ran: true, errors, scheduler_enabled: await this.storage.get<boolean>("scheduler:enabled") ?? false });
    }

    if (request.method === "POST" && url.pathname === "/start") {
      await this.storage.put("scheduler:enabled", true);
      await this.storage.setAlarm(Date.now());
      return Response.json({ started: true });
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      await this.storage.put("scheduler:enabled", false);
      await this.storage.deleteAlarm();
      return Response.json({ started: false });
    }
    if (request.method === "GET" && url.pathname === "/state") {
      return Response.json({
        enabled: await this.storage.get<boolean>("scheduler:enabled") ?? false,
        lastRunAt: await this.storage.get<number>("scheduler:last-run-at") ?? null,
        lastError: await this.storage.get<string>("scheduler:last-error") ?? null,
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private async processEventTeamSeed(job: EventTeamSeedJob): Promise<void> {
    if (!this.env.TEAM_RUNTIME || !this.env.EVENT_RUNTIME) throw new Error("TeamRuntime and EventRuntime must be bound");
    if (job.cursor >= job.teamKeys.length) {
      job.status = job.failedTeams > 0 ? "completed_with_errors" : "completed";
      job.activeTeamKey = null; job.updatedAt = Date.now();
      await this.storage.put(eventTeamSeedKey(job.eventKey), job); return;
    }
    const teamKey = job.teamKeys[job.cursor];
    job.activeTeamKey = teamKey;
    const headers = { Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Team-Key": teamKey };
    try {
      if (job.stage === "seed") {
        const registry = await this.storage.get<string[]>("registry:teams") ?? [];
        if (!registry.includes(teamKey)) await this.storage.put("registry:teams", [...registry, teamKey].sort());
        const stub = this.env.TEAM_RUNTIME.get(this.env.TEAM_RUNTIME.idFromName(teamKey));
        const response = await stub.fetch(new Request("https://team-runtime/seed?year=" + job.year, { method: "POST", headers }));
        if (!response.ok) throw new Error("TeamRuntime seed returned HTTP " + response.status);
        job.stage = "wait";
        job.nextDueAt = Date.now() + Math.max(10_000, this.providerRequestInterval() * 9);
      } else {
        const stub = this.env.TEAM_RUNTIME.get(this.env.TEAM_RUNTIME.idFromName(teamKey));
        const response = await stub.fetch(new Request("https://team-runtime/snapshot?year=" + job.year + "&noSchedule=1", { headers }));
        if (!response.ok) throw new Error("TeamRuntime snapshot returned HTTP " + response.status);
        const snapshot = await response.json() as { events?: Array<Record<string, unknown>> | null };
        if (!Array.isArray(snapshot.events)) throw new Error("Team event history is not available yet");
        const policy = eventPollingPolicy(this.env);
        for (const event of snapshot.events) {
          const eventKey = event.key;
          if (typeof eventKey !== "string" || !/^[a-zA-Z0-9_-]+$/.test(eventKey)) continue;
          const eventRegistry = await this.storage.get<string[]>("registry:events") ?? [];
          if (!eventRegistry.includes(eventKey)) await this.storage.put("registry:events", [...eventRegistry, eventKey].sort());
          const eventStub = this.env.EVENT_RUNTIME.get(this.env.EVENT_RUNTIME.idFromName(eventKey));
          const lifecycle = classifyEventLifecycle({
            start_date: String(event.start_date ?? ""), end_date: String(event.end_date ?? ""), timezone: String(event.timezone ?? ""),
          }, Date.now(), policy);
          const eventHeaders = { Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Event-Key": eventKey, "Content-Type": "application/json" };
          const eventResponse = !lifecycle || lifecycle.lifecycle === "expired"
            ? await eventStub.fetch(new Request("https://event-runtime/schedule", {
                method: "POST", headers: eventHeaders,
                body: JSON.stringify({ endpoints: eventResourceEndpoints(eventKey), intervalMs: 86_400_000, analyticsEnabled: false }),
              }))
            : await eventStub.fetch(new Request("https://event-runtime/lifecycle", {
                method: "POST", headers: eventHeaders,
                body: JSON.stringify({
                  lifecycle: lifecycle.lifecycle, analyticsEnabled: false, upcomingIntervalMs: policy.upcomingIntervalMs,
                  activeIntervalMs: policy.activeIntervalMs,
                  ...(lifecycle.completedUntil === null ? {} : { completedUntil: lifecycle.completedUntil }),
                }),
              }));
          if (!eventResponse.ok) throw new Error("EventRuntime registration failed for " + eventKey + " with HTTP " + eventResponse.status);
          job.historicalEventsScheduled += 1;
        }
        job.seededTeams += 1; job.cursor += 1; job.activeTeamKey = null;
        job.stage = "seed"; job.teamAttempts = 0; job.nextDueAt = Date.now() + 100;
      }
    } catch (error) {
      job.teamAttempts += 1;
      const detail = error instanceof Error ? error.message : String(error);
      if (job.teamAttempts >= 3) {
        job.errors.push({ team_key: teamKey, detail: detail.slice(0, 240), at: Date.now() });
        if (job.errors.length > 50) job.errors.splice(0, job.errors.length - 50);
        job.failedTeams += 1; job.cursor += 1; job.activeTeamKey = null;
        job.stage = "seed"; job.teamAttempts = 0; job.nextDueAt = Date.now() + 100;
      } else job.nextDueAt = Date.now() + Math.min(30_000, 2_000 * (2 ** job.teamAttempts));
    }
    job.updatedAt = Date.now();
    if (job.cursor >= job.teamKeys.length) {
      job.status = job.failedTeams > 0 ? "completed_with_errors" : "completed"; job.activeTeamKey = null;
    }
    await this.storage.put(eventTeamSeedKey(job.eventKey), job);
  }

  async alarm(): Promise<void> {
    const eventSeedJobs = await this.storage.list<EventTeamSeedJob>({ prefix: "admin:event-team-seed:" });
    const activeEventSeed = [...eventSeedJobs.values()].find((job) => job.status === "running");
    if (activeEventSeed) {
      if (activeEventSeed.nextDueAt <= Date.now()) await this.processEventTeamSeed(activeEventSeed);
      const refreshed = await this.storage.get<EventTeamSeedJob>(eventTeamSeedKey(activeEventSeed.eventKey));
      if (refreshed?.status === "running") await this.storage.setAlarm(Math.max(Date.now() + 100, refreshed.nextDueAt));
      else if (await this.storage.get<boolean>("scheduler:enabled") === true) await this.storage.setAlarm(Date.now() + eventPollingPolicy(this.env).discoveryIntervalMs);
      else await this.storage.deleteAlarm();
      return;
    }
    const activeJob = await this.storage.list<SeasonIngestJob>({ prefix: "admin:season-ingest:" });
    const runningJob = [...activeJob.values()].find((job) => job.status === "running");
    if (runningJob) {
      await this.processSeasonIngest(runningJob);
      const refreshed = await this.storage.get<SeasonIngestJob>(seasonIngestKey(runningJob.year));
      if (refreshed?.status === "running") await this.storage.setAlarm(Math.max(Date.now() + 100, refreshed.nextDueAt ?? Date.now() + 1_000));
      else if (await this.storage.get<boolean>("scheduler:enabled") === true) {
        await this.storage.setAlarm(Date.now() + eventPollingPolicy(this.env).discoveryIntervalMs);
      } else await this.storage.deleteAlarm();
      return;
    }
    if (await this.storage.get<boolean>("scheduler:enabled") !== true) return;
    const policy = eventPollingPolicy(this.env);
    try {
      await this.discoverAndSchedule(policy);
      await this.storage.delete("scheduler:last-error");
    } catch (error) {
      await this.storage.put("scheduler:last-error", error instanceof Error ? error.message : String(error));
    }
    try {
      await this.discoverTeams(new Date().getUTCFullYear());
      await this.storage.delete("scheduler:team-discovery-error");
    } catch (error) {
      await this.storage.put("scheduler:team-discovery-error", error instanceof Error ? error.message : String(error));
    }
    await this.storage.put("scheduler:last-run-at", Date.now());
    await this.storage.setAlarm(Date.now() + policy.discoveryIntervalMs);
  }

  private async isSeasonIngestCurrent(job: SeasonIngestJob): Promise<boolean> {
    const current = await this.storage.get<SeasonIngestJob>(seasonIngestKey(job.year));
    return current?.status === "running" && current.runGeneration === job.runGeneration;
  }

  private async persistSeasonIngest(job: SeasonIngestJob): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const current = await tx.get<SeasonIngestJob>(seasonIngestKey(job.year));
      if (!current || current.runGeneration !== job.runGeneration) return;
      if (current.status !== "running") job.status = current.status;
      await tx.put(seasonIngestKey(job.year), job);
    });
  }

  private async processSeasonIngest(job: SeasonIngestJob): Promise<void> {
    const key = seasonIngestKey(job.year);
    if (!(await this.isSeasonIngestCurrent(job))) return;
    const recordError = (kind: "team" | "event", entityKey: string, detail: string) => {
      job.recentErrors.push({ kind, key: entityKey, detail: detail.slice(0, 240), at: Date.now() });
      if (job.recentErrors.length > 100) job.recentErrors.splice(0, job.recentErrors.length - 100);
    };
    const currentEventDiscovery = await this.storage.get<DiscoveryCache>(ADMIN_DISCOVERY_PREFIX + job.year);
    const currentTeamDiscovery = await this.storage.get<TeamDiscoveryCache>(ADMIN_TEAM_DISCOVERY_PREFIX + job.year);
    if (currentEventDiscovery?.updatedAt !== job.eventDiscoveryUpdatedAt ||
        currentTeamDiscovery?.updatedAt !== job.teamDiscoveryUpdatedAt) {
      job.status = "paused";
      recordError("event", "season-discovery", "The retained discovery snapshot changed; review and restart the job from a fresh preview.");
      job.updatedAt = Date.now();
      await this.persistSeasonIngest(job);
      return;
    }
    if (teamResourceEndpoints(job.teamKeys[0] ?? "", job.year).length !== job.teamResourceCount ||
        eventResourceEndpoints(job.eventKeys[0] ?? "").length + 1 !== job.eventResourceCount) {
      job.status = "paused";
      recordError("event", "resource-inventory", "Configured resource builders changed; review and restart from a fresh preview.");
      job.updatedAt = Date.now();
      await this.persistSeasonIngest(job);
      return;
    }
    const intervalValue = this.env.PROVIDER_REQUEST_INTERVAL_MS;
    const requestInterval = intervalValue === undefined ? 1_000 : Number(intervalValue);
    const retry = (detail: string, kind: "team" | "event", entityKey: string) => {
      if (job.resourceAttempts > 0) job.counts.requests_retried += 1;
      job.resourceAttempts += 1;
      if (job.resourceAttempts >= 3) {
        recordError(kind, entityKey, detail);
        job.resourceAttempts = 0;
        if (kind === "team") job.teamResourceCursor += 1;
        else job.eventResourceCursor += 1;
        job.nextDueAt = Date.now() + SEASON_INGEST_BOOKKEEPING_DELAY_MS;
      } else {
        recordError(kind, entityKey, detail + " (retry " + job.resourceAttempts + "/3)");
        job.nextDueAt = Date.now() + Math.min(30_000, 1_000 * (2 ** job.resourceAttempts));
      }
    };
    try {
      if (job.phase === "teams") {
        if (job.teamCursor >= job.teamKeys.length) {
          job.phase = "events";
          job.updatedAt = Date.now();
          await this.persistSeasonIngest(job);
          return;
        }
        const teamKey = job.teamKeys[job.teamCursor];
        if (!this.env.TEAM_RUNTIME) throw new Error("TeamRuntime namespace is not bound");
        const resources = teamResourceEndpoints(teamKey, job.year);
        const stub = this.env.TEAM_RUNTIME.get(this.env.TEAM_RUNTIME.idFromName(teamKey));
        const teamRegistry = await this.storage.get<string[]>("registry:teams") ?? [];
        if (!teamRegistry.includes(teamKey)) await this.storage.put("registry:teams", [...teamRegistry, teamKey].sort());
        const headers = { Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Team-Key": teamKey };
        if (job.teamResourceCursor < resources.length) {
          const resource = resources[job.teamResourceCursor];
          const stateResponse = await stub.fetch(new Request("https://team-runtime/state", { headers }));
          let resourceState: { status?: string; revision?: number; last_fetched_at?: number | null; expires_at?: number | null } | undefined;
          if (stateResponse.ok) {
            const state = await stateResponse.json() as { endpoints?: Array<{ endpoint: string; status?: string; revision?: number; last_fetched_at?: number | null; expires_at?: number | null }> };
            resourceState = state.endpoints?.find((item) => item.endpoint === resource.endpoint);
          }
          if ((resourceState?.last_fetched_at != null && resourceState.status === "available" && (resourceState.expires_at == null || resourceState.expires_at > Date.now())) || resourceState?.status === "unavailable") {
            job.counts.requests_skipped += 1;
            if (resourceState?.status === "unavailable") job.counts.requests_unavailable += 1;
            job.teamResourceCursor += 1;
            job.resourceAttempts = 0;
            job.nextDueAt = Date.now() + SEASON_INGEST_BOOKKEEPING_DELAY_MS;
          } else {
            if (!(await this.isSeasonIngestCurrent(job))) return;
            const response = await stub.fetch(new Request("https://team-runtime/ingest-resource?year=" + job.year, {
              method: "POST", headers: { ...headers, "Content-Type": "application/json" },
              body: JSON.stringify({ endpoint: resource.endpoint }),
            }));
            if (response.status === 202) {
              job.counts.requests_deferred += 1;
              const deferred = await response.json() as { retry_at?: number };
              job.nextDueAt = deferred.retry_at ?? Date.now() + requestInterval;
            } else if (!response.ok) {
              job.counts.requests_attempted += 1;
              job.counts.requests_failed += 1;
              retry("Team resource " + resource.endpoint + " returned HTTP " + response.status, "team", teamKey);
            } else {
              job.counts.requests_attempted += 1;
              const result = await response.json() as { status?: string; success?: boolean; revision?: number; last_error?: string | null };
              
              if (result.status === "unavailable") {
                job.counts.requests_unavailable += 1;
                recordError("team", teamKey, resource.endpoint + " is unavailable");
                job.teamResourceCursor += 1;
                job.resourceAttempts = 0;
                job.nextDueAt = Date.now() + SEASON_INGEST_BOOKKEEPING_DELAY_MS;
              } else if (result.status === "failed" || result.success === false) {
                job.counts.requests_failed += 1;
                retry(result.last_error ?? (resource.endpoint + " failed"), "team", teamKey);
              } else {
                job.counts.requests_succeeded += 1;
                job.teamResourceCursor += 1;
                job.resourceAttempts = 0;
                job.nextDueAt = Date.now() + requestInterval;
              }
            }
          }
        } else {
          const verify = await stub.fetch(new Request("https://team-runtime/state", { headers }));
          if (!verify.ok) throw new Error("Unable to verify TeamRuntime state: HTTP " + verify.status);
          const state = await verify.json() as { snapshot_revision?: number; endpoints?: Array<{ last_fetched_at?: number | null; expires_at?: number | null; status?: string }> };
          const endpoints = state.endpoints ?? [];
          job.teamSnapshotRevision += state.snapshot_revision ?? 0;
          const acquired = endpoints.filter((item) => item.last_fetched_at != null).length;
          const unavailable = endpoints.filter((item) => item.status === "unavailable").length;
          const failed = endpoints.filter((item) => item.status === "failed").length;
          const stale = endpoints.filter((item) => item.status === "stale" || (item.expires_at != null && item.expires_at < Date.now())).length;
          const snapshot = await stub.fetch(new Request("https://team-runtime/snapshot?year=" + job.year + "&noSchedule=1", { headers }));
          if (!snapshot.ok) throw new Error("TeamRuntime season snapshot generation returned HTTP " + snapshot.status);
          if (acquired === resources.length && failed === 0 && unavailable === 0 && stale === 0) job.counts.teams_complete += 1;
          else if (acquired > 0) job.counts.teams_partial += 1;
          else job.counts.teams_failed += 1;
          await this.storage.put("registry:teams", [...new Set([...(await this.storage.get<string[]>("registry:teams") ?? []), teamKey])].sort());
          job.teamCursor += 1;
          job.teamResourceCursor = 0;
          job.resourceAttempts = 0;
          job.nextDueAt = Date.now() + SEASON_INGEST_BOOKKEEPING_DELAY_MS;
        }
      } else if (job.phase === "events") {
        if (job.eventCursor >= job.eventKeys.length) {
          job.phase = "complete";
          const failures = job.counts.teams_partial + job.counts.teams_failed + job.counts.event_state_partial +
            job.counts.event_state_missing + job.counts.event_state_failed + job.counts.event_analytics_partial +
            job.counts.event_analytics_waiting + job.counts.event_analytics_missing + job.counts.event_analytics_failed +
            job.counts.event_cohort_partial + job.counts.event_cohort_discovering +
            job.counts.event_cohort_missing;
          job.status = failures > 0 ? "completed_with_errors" : "completed";
          delete job.nextDueAt;
          job.updatedAt = Date.now();
          await this.persistSeasonIngest(job);
          return;
        }
        const eventIndex = job.eventCursor;
        const eventKey = job.eventKeys[job.eventCursor];
        const eventDiscovery = await this.storage.get<DiscoveryCache>(ADMIN_DISCOVERY_PREFIX + job.year);
        const event = eventDiscovery?.events.find((item) => item.key === eventKey);
        const stub = this.env.EVENT_RUNTIME.get(this.env.EVENT_RUNTIME.idFromName(eventKey));
        const runtimeEvents = await this.storage.get<string[]>("registry:runtime-events") ?? [];
        if (!runtimeEvents.includes(eventKey)) await this.storage.put("registry:runtime-events", [...runtimeEvents, eventKey].sort());
        const registryEvents = await this.storage.get<string[]>("registry:events") ?? [];
        if (!registryEvents.includes(eventKey)) await this.storage.put("registry:events", [...registryEvents, eventKey].sort());
        const headers = {
          Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
          "X-FieldView-Event-Key": eventKey,
          "Content-Type": "application/json",
        };
        const resources = [
          ...eventResourceEndpoints(eventKey),
          STATBOTICS_ENDPOINTS.matches({ event: eventKey }, 1000, 0),
        ];
        if (job.eventResourceCursor === 0 || job.eventResourceCursor >= resources.length) {
          const preflight = await stub.fetch(new Request("https://event-runtime/state", { headers }));
          if (preflight.ok) {
            const current = await preflight.json() as {
              event_state?: { status?: string; source_revision?: number | null };
              analytics?: { status?: string; source_revision?: number | null; season_team_revision?: number | null; cohort_status?: string | null };
            };
            const artifactsReusable = current.event_state?.status === "complete" &&
              current.event_state.source_revision != null &&
              current.analytics?.source_revision === current.event_state.source_revision &&
              current.analytics?.season_team_revision === job.teamSnapshotRevision &&
              (current.analytics?.status === "succeeded" || current.analytics?.status === "partial") &&
              current.analytics?.cohort_status === "complete";
            if (artifactsReusable) {
              job.counts.requests_skipped += resources.length;
              job.counts.event_state_complete += 1;
              if (current.analytics?.status === "succeeded") job.counts.event_analytics_succeeded += 1;
              else job.counts.event_analytics_partial += 1;
              job.counts.event_cohort_complete += 1;
              job.eventCursor += 1;
              job.eventResourceCursor = 0;
              job.resourceAttempts = 0;
              job.nextDueAt = Date.now() + SEASON_INGEST_BOOKKEEPING_DELAY_MS;
            }
          }
        }
        if (job.eventCursor === eventIndex && !(await this.isSeasonIngestCurrent(job))) return;
        if (job.eventCursor === eventIndex) {
        if (job.eventResourceCursor < resources.length) {
          const endpoint = resources[job.eventResourceCursor];
          const stateResponse = await stub.fetch(new Request("https://event-runtime/state", { headers }));
          let resourceState: { status?: string; lastFetchedAt?: number | null; lastWebhookAt?: number | null; expiresAt?: number | null } | undefined;
          if (stateResponse.ok) {
            const state = await stateResponse.json() as { endpoints?: Record<string, { status?: string; lastFetchedAt?: number | null; lastWebhookAt?: number | null; expiresAt?: number | null }> };
            resourceState = state.endpoints?.["endpoint:" + endpoint];
          }
          if (((resourceState?.lastFetchedAt != null || resourceState?.lastWebhookAt != null) && resourceState.status === "available" && (resourceState.expiresAt == null || resourceState.expiresAt > Date.now())) || resourceState?.status === "unavailable") {
            job.counts.requests_skipped += 1;
            if (resourceState?.status === "unavailable") job.counts.requests_unavailable += 1;
            job.eventResourceCursor += 1;
            job.resourceAttempts = 0;
            job.nextDueAt = Date.now() + SEASON_INGEST_BOOKKEEPING_DELAY_MS;
          } else {
            if (!(await this.isSeasonIngestCurrent(job))) return;
            const response = await stub.fetch(new Request("https://event-runtime/ingest-resource", {
              method: "POST", headers,
              body: JSON.stringify({ endpoint }),
            }));
            if (response.status === 202) {
              job.counts.requests_deferred += 1;
              const deferred = await response.json() as { retry_at?: number };
              job.nextDueAt = deferred.retry_at ?? Date.now() + requestInterval;
            } else if (!response.ok) {
              job.counts.requests_attempted += 1;
              job.counts.requests_failed += 1;
              retry("Event resource " + endpoint + " returned HTTP " + response.status, "event", eventKey);
            } else {
              job.counts.requests_attempted += 1;
              const result = await response.json() as { status?: string; success?: boolean; last_error?: string | null };
              if (result.status === "unavailable") {
                job.counts.requests_unavailable += 1;
                recordError("event", eventKey, endpoint + " is unavailable");
                job.eventResourceCursor += 1;
                job.resourceAttempts = 0;
                job.nextDueAt = Date.now() + SEASON_INGEST_BOOKKEEPING_DELAY_MS;
              } else if (result.status === "failed" || result.success === false) {
                job.counts.requests_failed += 1;
                retry(result.last_error ?? (endpoint + " failed"), "event", eventKey);
              } else {
                job.counts.requests_succeeded += 1;
                job.eventResourceCursor += 1;
                job.resourceAttempts = 0;
                job.nextDueAt = Date.now() + requestInterval;
              }
            }
          }
        } else {
          if (!(await this.isSeasonIngestCurrent(job))) return;
          const snapshot = await stub.fetch(new Request("https://event-runtime/publish-state", {
            method: "POST",
            headers: { Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Event-Key": eventKey },
          }));
          if (!snapshot.ok) throw new Error("EventState generation returned HTTP " + snapshot.status);
          const stateResponse = await stub.fetch(new Request("https://event-runtime/state", { headers }));
          if (!stateResponse.ok) throw new Error("Unable to verify EventState publication");
          const eventState = await stateResponse.json() as { event_state?: { status?: string } };
          const stateStatus = eventState.event_state?.status ?? "missing";
          if (stateStatus === "complete") job.counts.event_state_complete += 1;
          else if (stateStatus === "partial") job.counts.event_state_partial += 1;
          else if (stateStatus === "failed") job.counts.event_state_failed += 1;
          else job.counts.event_state_missing += 1;

          const recalculate = await stub.fetch(new Request("https://event-runtime/recalculate", {
             method: "POST",
             headers,
             body: JSON.stringify({ allowPartialCohort: true, seasonTeamRevision: job.teamSnapshotRevision }),
           }));
          if (!recalculate.ok) throw new Error("EventAnalytics calculation request returned HTTP " + recalculate.status);
          const analyticsResponse = await stub.fetch(new Request("https://event-runtime/analytics", {
            headers: { "X-FieldView-Event-Key": eventKey },
          }));
          if (!analyticsResponse.ok) throw new Error("Unable to verify EventAnalytics publication");
          const analytics = await analyticsResponse.json() as { status?: string; publication?: unknown };
          if (analytics.status === "succeeded" && analytics.publication) job.counts.event_analytics_succeeded += 1;
          else if (analytics.status === "partial" && analytics.publication) job.counts.event_analytics_partial += 1;
          else if (analytics.status === "waiting-for-cohort") job.counts.event_analytics_waiting += 1;
          else if (analytics.status === "failed") job.counts.event_analytics_failed += 1;
          else job.counts.event_analytics_missing += 1;
          const publication = isRecord(analytics.publication) ? analytics.publication : null;
          const eventAnalytics = publication && isRecord(publication.eventAnalytics) ? publication.eventAnalytics : null;
          const cohort = eventAnalytics && isRecord(eventAnalytics.season_cohort) ? eventAnalytics.season_cohort : null;
          const cohortStatus = cohort?.state;
          if (cohortStatus === "complete") job.counts.event_cohort_complete += 1;
          else if (cohortStatus === "partial") job.counts.event_cohort_partial += 1;
          else if (cohortStatus === "discovering" || analytics.status === "waiting-for-cohort") job.counts.event_cohort_discovering += 1;
          else job.counts.event_cohort_missing += 1;

          if (event) {
            const decision = classifyEventLifecycle(event, Date.now(), eventPollingPolicy(this.env));
            if (decision) {
              await stub.fetch(new Request("https://event-runtime/lifecycle", {
                method: "POST", headers,
                body: JSON.stringify({
                  lifecycle: decision.lifecycle,
                  upcomingIntervalMs: eventPollingPolicy(this.env).upcomingIntervalMs,
                  activeIntervalMs: eventPollingPolicy(this.env).activeIntervalMs,
                  ...(decision.completedUntil === null ? {} : { completedUntil: decision.completedUntil }),
                }),
              }));
            }
          }
          const runtimeEvents = await this.storage.get<string[]>("registry:runtime-events") ?? [];
          if (!runtimeEvents.includes(eventKey)) await this.storage.put("registry:runtime-events", [...runtimeEvents, eventKey].sort());
          const registryEvents = await this.storage.get<string[]>("registry:events") ?? [];
          if (!registryEvents.includes(eventKey)) await this.storage.put("registry:events", [...registryEvents, eventKey].sort());
          job.eventCursor += 1;
          job.eventResourceCursor = 0;
          job.resourceAttempts = 0;
          job.nextDueAt = Date.now() + SEASON_INGEST_BOOKKEEPING_DELAY_MS;
        }
        }
      }
    } catch (error) {
      const kind = job.phase === "teams" ? "team" : "event";
      const entityKey = kind === "team" ? job.teamKeys[job.teamCursor] : job.eventKeys[job.eventCursor];
      const detail = error instanceof Error ? error.message : String(error);
      const finalizingTeam = kind === "team" && job.teamResourceCursor >= teamResourceEndpoints(entityKey ?? "", job.year).length;
      const finalizingEvent = kind === "event" && job.eventResourceCursor >= eventResourceEndpoints(entityKey ?? "").length + 1;
      if (finalizingTeam || finalizingEvent) {
        job.resourceAttempts += 1;
        recordError(kind, entityKey ?? "unknown", detail + " (finalization retry " + job.resourceAttempts + "/3)");
        if (job.resourceAttempts >= 3) {
          if (kind === "team") {
            job.counts.teams_failed += 1;
            job.teamCursor += 1;
            job.teamResourceCursor = 0;
          } else {
            job.counts.event_state_failed += 1;
            job.counts.event_analytics_failed += 1;
            job.eventCursor += 1;
            job.eventResourceCursor = 0;
          }
          job.resourceAttempts = 0;
        }
        job.nextDueAt = Date.now() + Math.min(30_000, 1_000 * (2 ** job.resourceAttempts));
      } else {
        retry(detail, kind, entityKey ?? "unknown");
      }
    }
    job.updatedAt = Date.now();
    await this.persistSeasonIngest(job);
  }

  private async discoverEvents(year: number): Promise<void> {
    const cacheKey = ADMIN_DISCOVERY_PREFIX + year;
    const cached = await this.storage.get<DiscoveryCache>(cacheKey);
    const headers = new Headers();
    if (cached?.etag) headers.set("If-None-Match", cached.etag);
    const response = await this.requestWithProviderGate(TBA_ENDPOINTS.events(year), () => this.api.request(TBA_ENDPOINTS.events(year), { headers }));
    if (response.status === 304 && cached) {
      await this.storage.put(cacheKey, { ...cached, complete: true, checkedAt: Date.now() } satisfies DiscoveryCache);
      return;
    }
    if (!response.ok) throw new Error("TBA event discovery failed for " + year + " with HTTP " + response.status);
    const events = await response.json() as TBAEvent[];
    if (!Array.isArray(events)) throw new Error("TBA event discovery returned a non-array payload");
    const now = Date.now();
    await this.storage.put(cacheKey, {
      etag: response.headers.get("ETag"), events, complete: true, updatedAt: now, checkedAt: now,
    } satisfies DiscoveryCache);
  }

  private async readDiscoveredTeams(year: number, prefix = TEAM_DISCOVERY_PREFIX): Promise<TBATeam[] | null> {
    const key = prefix + year;
    const cache = await this.storage.get<TeamDiscoveryCache>(key);
    if (!cache?.complete || !Number.isSafeInteger(cache.pageCount)) return null;
    if (cache.teams) return cache.teams;
    const teams: TBATeam[] = [];
    for (let page = 0; page < (cache.pageCount ?? 0); page += 1) {
      const values = await this.storage.get<TBATeam[]>(key + ":page:" + page);
      if (!values) return null;
      teams.push(...values);
    }
    return teams;
  }

  private async discoverTeams(year: number, prefix = TEAM_DISCOVERY_PREFIX): Promise<{ requestCount: number; pageCount: number; teamCount: number }> {
    const key = prefix + year;
    const cached = await this.storage.get<TeamDiscoveryCache>(key);
    const pages: TBATeam[][] = [];
    const pageEtags: Record<string, string | null> = {};
    let requestCount = 0;
    let complete = false;
    let payloadChanged = !cached?.complete;
    // TBA season-team endpoints are paginated in fixed groups of 500. Walk
    // sequentially, retain per-page validators, and require a short final page.
    for (let page = 0; page < 100; page += 1) {
      const pageKey = String(page);
      const cachedPage = await this.storage.get<TBATeam[]>(key + ":page:" + page) ??
        (page === 0 ? cached?.teams : undefined);
      const etag = cached?.pageEtags?.[pageKey] ?? null;
      const headers = new Headers();
      if (etag) headers.set("If-None-Match", etag);
      const endpoint = TBA_ENDPOINTS.teamsByYearPage(year, page);
      const response = await this.requestWithProviderGate(endpoint, () => this.api.request(endpoint, { headers }));
      requestCount += 1;
      let pageTeams: TBATeam[];
      if (response.status === 304) {
        if (!cachedPage) throw new Error("TBA team page " + page + " returned 304 without a retained page payload");
        pageTeams = cachedPage;
        pageEtags[pageKey] = etag;
      } else {
        if (!response.ok) throw new Error("TBA team discovery page " + page + " failed for " + year + " with HTTP " + response.status);
        pageTeams = await response.json() as TBATeam[];
        if (!Array.isArray(pageTeams) || pageTeams.length > 500) throw new Error("TBA team discovery page " + page + " returned an invalid payload");
        pageEtags[pageKey] = response.headers.get("ETag");
        payloadChanged = true;
      }
      pages.push(pageTeams);
      if (pageTeams.length < 500) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new Error("TBA team discovery exceeded the 100-page safety limit; season inventory is incomplete");
    const teams = [...new Map(pages.flat().filter((team) => typeof team?.key === "string" && /^frc\d+$/.test(team.key)).map((team) => [team.key, team])).values()];
    if (teams.length === 0) throw new Error("TBA returned zero teams for " + year + "; refusing to mark the season inventory complete");
    for (let page = 0; page < pages.length; page += 1) await this.storage.put(key + ":page:" + page, pages[page]);
    for (let page = pages.length; page < (cached?.pageCount ?? 0); page += 1) await this.storage.delete(key + ":page:" + page);
    const checkedAt = Date.now();
    const updatedAt = payloadChanged ? checkedAt : cached?.updatedAt ?? checkedAt;
    await this.storage.put(key, {
      etag: pageEtags["0"] ?? null, pageEtags, pageCount: pages.length,
      teamCount: teams.length, teamKeys: teams.map((team) => team.key).sort(),
      complete: true, updatedAt, checkedAt,
    } satisfies TeamDiscoveryCache);
    return { requestCount, pageCount: pages.length, teamCount: teams.length };
  }

  private async discoverAndSchedule(policy: EventPollingPolicy): Promise<void> {
    const year = new Date().getUTCFullYear();
    const events = new Map<string, TBAEvent>();
    // Routine discovery keeps only the active calendar year's cache. Admin-prepared
    // historical snapshots live under separate prefixes and are not pruned here.
    const discoveryEntries = await this.storage.list<DiscoveryCache>({ prefix: DISCOVERY_PREFIX });
    for (const key of discoveryEntries.keys()) {
      if (key !== DISCOVERY_PREFIX + year) await this.storage.delete(key);
    }
    // FieldView only needs the current calendar year's discovery cache.
    for (const discoveryYear of [year]) {
      const endpoint = TBA_ENDPOINTS.events(discoveryYear);
      const cacheKey = DISCOVERY_PREFIX + discoveryYear;
      const cached = await this.storage.get<DiscoveryCache>(cacheKey);
      const headers = new Headers();
      if (cached?.etag) headers.set("If-None-Match", cached.etag);
      const response = await this.requestWithProviderGate(endpoint, () => this.api.request(endpoint, { headers }));
      let discovered: TBAEvent[];
      if (response.status === 304 && cached) {
        discovered = cached.events;
        await this.storage.put(cacheKey, { ...cached, checkedAt: Date.now() } satisfies DiscoveryCache);
      } else if (response.ok) {
        discovered = await response.json() as TBAEvent[];
        if (!Array.isArray(discovered)) throw new Error("TBA event discovery returned a non-array payload");
        const retrievedAt = Date.now();
        await this.storage.put(cacheKey, {
          etag: response.headers.get("ETag"),
          events: discovered,
          updatedAt: retrievedAt,
          checkedAt: retrievedAt,
        } satisfies DiscoveryCache);
      } else {
        throw new Error("TBA event discovery failed for " + discoveryYear + " with HTTP " + response.status);
      }
      for (const event of discovered) if (event.key) events.set(event.key, event);
    }

    const scheduledKeys = new Set(await this.storage.get<string[]>("scheduler:event-keys") ?? []);
    const runtimeEventKeys = new Set(await this.storage.get<string[]>("registry:runtime-events") ?? []);
    // A previous multi-year scheduler may have left future-year EventRuntime
    // polls active. Stop those runtimes now that discovery is current-year-only.
    for (const eventKey of [...scheduledKeys]) {
      const eventYear = /^([0-9]{4})/.exec(eventKey)?.[1];
      if (!eventYear || Number(eventYear) === year) continue;
      const stub = this.env.EVENT_RUNTIME.get(this.env.EVENT_RUNTIME.idFromName(eventKey));
      const response = await stub.fetch(new Request("https://event-runtime/lifecycle", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
          "X-FieldView-Event-Key": eventKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          lifecycle: "expired",
          upcomingIntervalMs: policy.upcomingIntervalMs,
          activeIntervalMs: policy.activeIntervalMs,
        }),
      }));
      if (!response.ok) throw new Error("Failed to stop out-of-year event " + eventKey + ": HTTP " + response.status);
      scheduledKeys.delete(eventKey);
    }

    const knownEvents = [...new Set([...(await this.storage.get<string[]>("registry:events") ?? []), ...events.keys()])].sort();
    await this.storage.put("registry:events", knownEvents);

    for (const event of events.values()) {
      const decision = classifyEventLifecycle(event, Date.now(), policy);
      if (!decision) continue;
      // Historical event lists contain years of completed events. Only send an
      // expiry instruction for events this scheduler previously activated.
      if (decision.lifecycle === "expired" && !scheduledKeys.has(event.key)) continue;
      if (decision.lifecycle === "expired") scheduledKeys.delete(event.key);
      else scheduledKeys.add(event.key);
      const stub = this.env.EVENT_RUNTIME.get(this.env.EVENT_RUNTIME.idFromName(event.key));
      const response = await stub.fetch(new Request("https://event-runtime/lifecycle", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
          "X-FieldView-Event-Key": event.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          lifecycle: decision.lifecycle,
          upcomingIntervalMs: policy.upcomingIntervalMs,
          activeIntervalMs: policy.activeIntervalMs,
          ...(decision.completedUntil === null ? {} : { completedUntil: decision.completedUntil }),
        }),
      }));
      if (!response.ok) throw new Error("Failed to schedule " + event.key + ": HTTP " + response.status);
      runtimeEventKeys.add(event.key);
    }
    await this.storage.put("scheduler:event-keys", [...scheduledKeys]);
    await this.storage.put("registry:runtime-events", [...runtimeEventKeys].sort());
  }
}
