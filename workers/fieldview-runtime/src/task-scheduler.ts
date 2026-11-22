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
const THIS_WEEK_PROJECTION_KEY = "scheduler:this-week-projection";
const THIS_WEEK_PROGRESS_KEY = "scheduler:this-week-progress";
const THIS_WEEK_LAST_RUN_KEY = "scheduler:this-week-last-run-date";

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

function addDateOnlyDays(value: string, days: number): string | null {
  const parts = parseDateOnly(value);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * 86_400_000)
    .toISOString().slice(0, 10);
}

function dateOnlyInTimezone(now: number, timeZone: string): string | null {
  try {
    const values = new Map(new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(now)).map((part) => [part.type, part.value]));
    return String(values.get("year")).padStart(4, "0") + "-" +
      String(values.get("month")).padStart(2, "0") + "-" +
      String(values.get("day")).padStart(2, "0");
  } catch {
    return null;
  }
}

export interface EventWeekClassification {
  isThisWeek: boolean;
  localDate: string;
  weekStart: string;
  weekEnd: string;
}

/**
 * Event start/end are inclusive date-only values, not timestamps. The event
 * timezone determines today's calendar date; overlap is tested against that
 * local Monday-Sunday week using date strings only.
 */
export function classifyEventThisWeek(
  event: Pick<TBAEvent, "start_date" | "end_date" | "timezone">,
  now: number,
): EventWeekClassification | null {
  const start = event.start_date;
  const end = event.end_date;
  if (!parseDateOnly(start) || !parseDateOnly(end) || start > end ||
      typeof event.timezone !== "string" || event.timezone.length === 0) return null;
  const localDate = dateOnlyInTimezone(now, event.timezone);
  if (!localDate) return null;
  const localParts = parseDateOnly(localDate);
  if (!localParts) return null;
  const weekday = new Date(Date.UTC(localParts.year, localParts.month - 1, localParts.day)).getUTCDay();
  const weekStart = addDateOnlyDays(localDate, -((weekday + 6) % 7));
  const weekEnd = weekStart === null ? null : addDateOnlyDays(weekStart, 6);
  if (weekStart === null || weekEnd === null) return null;
  return {
    isThisWeek: start <= weekEnd && end >= weekStart,
    localDate,
    weekStart,
    weekEnd,
  };
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

interface ThisWeekProgress {
  runDate: string;
  eventKeys: string[];
  cursor: number;
  includedKeys: string[];
}


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
  /** Immutable page generation selected by the published metadata record. */
  pagePrefix?: string;
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
  stage: "discover" | "seed" | "wait"; teamKeys: string[]; cursor: number; activeTeamKey: string | null;
  teamAttempts: number; teamWaitStartedAt?: number; seededTeams: number; failedTeams: number; historicalEventsScheduled: number;
  errors: Array<{ team_key: string; detail: string; at: number }>;
  eventKeys?: string[]; eventCursor?: number;
  startedAt: number; updatedAt: number; nextDueAt: number; resumeAlarmAt: number | null;
}
const eventTeamSeedKey = (eventKey: string) => "admin:event-team-seed:" + eventKey;

type CoverageAuditRecord = {
  year: number; status: string; started_at: number; updated_at: number;
  event_discovery_updated_at?: number; team_discovery_updated_at?: number;
  event_keys: string[]; team_keys: string[]; cursor: number;
  counts: Record<string, number>;
};
interface TeamSeedJob {
  teamKey: string;
  year: number;
  status: "running" | "completed" | "completed_with_errors";
  stage: "seed" | "wait" | "events";
  eventKeys: string[];
  events: Array<Record<string, unknown>>;
  eventCursor: number;
  waitStartedAt: number;
  attempts: number;
  scheduledEvents: number;
  errors: Array<{ event_key: string; detail: string; at: number }>;
  startedAt: number;
  updatedAt: number;
  nextDueAt: number;
}
const teamSeedKey = (teamKey: string, year: number) => "admin:team-seed:" + teamKey + ":" + year;

interface AdminDiscoveryJob {
  year: number;
  mode: "current" | "year";
  status: "running" | "completed" | "failed";
  stage: "events" | "teams" | "lifecycle" | "this-week" | "complete";
  events: number;
  teams: number;
  steps: number;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  nextDueAt: number;
}
const adminDiscoveryKey = (mode: "current" | "year", year: number) => "admin:discovery-job:" + mode + ":" + year;


/** System-wide discovery and cross-runtime job orchestrator; entity runtimes execute dispatched work. */
export class TaskScheduler {
  private readonly storage: DurableObjectStateLike["storage"];
  private readonly api: TBAApiClient;
  private readonly env: RuntimeEnvironment;
  private readonly activation: Promise<void>;

  constructor(state: DurableObjectStateLike, env: RuntimeEnvironment) {
    this.storage = state.storage;
    this.env = env;
    this.api = new TBAApiClient({
      apiKey: env.TBA_API_KEY,
      ...(env.fetcher ? { fetch: env.fetcher } : {}),
    });
    // Durable Objects activate on demand. On each TaskScheduler activation,
    // restore the current-season index invariant from its own storage and arm
    // background discovery if the index is absent or stale. No provider or
    // entity-runtime calls occur during activation.
    this.activation = state.blockConcurrencyWhile
      ? state.blockConcurrencyWhile(async () => {
          // Districts are retained only as team/event membership references.
          // Retire legacy scheduler-owned district directory/resource payloads.
          for (const prefix of ["district-directory:", "district-resource:"]) {
            const legacyRecords = await this.storage.list({ prefix });
            for (const key of legacyRecords.keys()) await this.storage.delete(key);
          }
          // Scheduled discovery is owned by the fieldview-jobs Workflow.
        })
      : Promise.resolve();
  }

  async fetch(request: Request): Promise<Response> {
    const startedAt = performance.now();
    const url = new URL(request.url);
    try {
      await this.activation;
      return await this.handleFetch(request);
    } finally {
      console.log("[FV][TaskScheduler] request", JSON.stringify({
        method: request.method,
        path: url.pathname,
        duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
      }));
    }
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/events") {
      const year = Number(url.searchParams.get("year"));
      if (!Number.isSafeInteger(year) || year < 1992 || year > 2200) {
        return Response.json({ error: "Invalid discovery year" }, { status: 400 });
      }
      const cached = await this.storage.get<DiscoveryCache>(DISCOVERY_PREFIX + year);
      const currentYear = new Date().getUTCFullYear();
      if (!cached) {
        return Response.json({
          year, events: [], status: "unavailable",
          index: { status: "missing", persisted: false },
          revalidation: "unavailable",
        }, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } });
      }
      const retrievedAt = new Date(cached.updatedAt).toISOString();
      const checkedAt = cached.checkedAt ?? cached.updatedAt;
      const isStale = Date.now() - checkedAt > eventPollingPolicy(this.env).discoveryIntervalMs;
      const sourceStatus = isStale ? "stale" as const : "available" as const;
      const events = cached.events.map((event) => normalizeFieldViewEvent(event, {
        tba_event: {
          status: sourceStatus,
          retrieved_at: retrievedAt,
          ...(cached.etag === null ? {} : { validator: cached.etag }),
        },
      }));
      const indexError = year === currentYear
        ? await this.storage.get<string>("scheduler:current-season-index-error") ?? null
        : null;
      return Response.json(
        {
          year, events, updatedAt: cached.updatedAt, checkedAt,
          index: { status: sourceStatus, persisted: true, last_error: indexError },
          revalidation: isStale ? "workflow_managed" : "idle",
        },
        {
          headers: {
            "Cache-Control": "public, max-age=300, stale-while-revalidate=300",
            ...(cached.etag === null ? {} : { ETag: cached.etag }),
          },
        },
      );
    }

    if (request.method === "GET" && url.pathname === "/events/this-week") {
      const projection = await this.storage.get<{ evaluatedAt: number; runDate: string; checkedAt?: number; events: TBAEvent[] }>(THIS_WEEK_PROJECTION_KEY);
      if (!projection) {
        return Response.json(
          { runDate: "", evaluatedAt: Date.now(), events: [], pending: false, status: "unavailable" },
          { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" } },
        );
      }
      const retrievedAt = new Date(projection.checkedAt ?? projection.evaluatedAt).toISOString();
      const sourceStatus = Date.now() - (projection.checkedAt ?? projection.evaluatedAt) > eventPollingPolicy(this.env).discoveryIntervalMs * 2
        ? "stale" as const
        : "available" as const;
      const events = projection.events.map((event) => normalizeFieldViewEvent(event, {
        tba_event: { status: sourceStatus, retrieved_at: retrievedAt },
      }));
      return Response.json(
        { runDate: projection.runDate, evaluatedAt: projection.evaluatedAt, events },
        { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=300" } },
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

 
    if (request.method === "GET" && url.pathname === "/admin/discovery-job") {
      const year = Number(url.searchParams.get("year"));
      const mode = url.searchParams.get("mode") === "year" ? "year" : "current";
      if (!Number.isSafeInteger(year) || year < 1992 || year > 2200) return Response.json({ error: "Invalid discovery year" }, { status: 400 });
      return Response.json(await this.storage.get<AdminDiscoveryJob>(adminDiscoveryKey(mode, year)) ??
        { year, mode, status: "not_started" }, { headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "POST" && url.pathname === "/admin/discover-year") {
      const year = Number(url.searchParams.get("year"));
      if (!Number.isSafeInteger(year) || year < 1992 || year > 2200) {
        return Response.json({ error: "Invalid discovery year" }, { status: 400 });
      }
      const activeJobs = await this.storage.list<SeasonIngestJob>({ prefix: "admin:season-ingest:" });
      if ([...activeJobs.values()].some((job) => job.status === "running" || job.status === "paused")) {
        return Response.json({ error: "Resume, cancel, or complete the active season-ingest job before refreshing discovery." }, { status: 409 });
      }
      const key = adminDiscoveryKey("year", year);
      const current = await this.storage.get<AdminDiscoveryJob>(key);
      if (current?.status === "running") return Response.json(current, { status: 202 });
      const now = Date.now();
      const job: AdminDiscoveryJob = {
        year, mode: "year", status: "running", stage: "events",
        events: 0, teams: 0, steps: 0, error: null,
        startedAt: now, updatedAt: now, nextDueAt: now,
      };
      await this.storage.put(key, job);
      await this.storage.setAlarm(now);
      return Response.json(job, { status: 202, headers: { "Cache-Control": "no-store" } });
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
      const now = Date.now();
      const job: EventTeamSeedJob = {
        eventKey, year, status: "running", stage: "discover", teamKeys: [], cursor: 0, activeTeamKey: null,
        teamAttempts: 0, seededTeams: 0, failedTeams: 0, historicalEventsScheduled: 0,
        errors: [], startedAt: now, updatedAt: now, nextDueAt: now,
        resumeAlarmAt: await this.storage.getAlarm?.() ?? null,
      };
      await this.storage.put(eventTeamSeedKey(eventKey), job);
      await this.storage.setAlarm(now);
      return Response.json(job, { status: 202, headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/admin/team-seed" && request.method === "GET") {
      const teamKey = url.searchParams.get("team_key") ?? "";
      const year = Number(url.searchParams.get("year"));
      if (!/^frc\d+$/.test(teamKey) || !Number.isSafeInteger(year) || year < 1992 || year > 2200) {
        return Response.json({ error: "A valid team_key and year are required" }, { status: 400 });
      }
      return Response.json(await this.storage.get<TeamSeedJob>(teamSeedKey(teamKey, year)) ??
        { team_key: teamKey, year, status: "not_started" }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/admin/team-seed" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || typeof body.team_key !== "string" || !/^frc\d+$/.test(body.team_key)) {
        return Response.json({ error: "A valid team_key is required" }, { status: 400 });
      }
      const teamKey = body.team_key;
      const year = Number(body.year);
      if (!Number.isSafeInteger(year) || year < 1992 || year > new Date().getUTCFullYear() + 1) {
        return Response.json({ error: "Invalid team seed year" }, { status: 400 });
      }
      if (!this.env.TEAM_RUNTIME || !this.env.EVENT_RUNTIME) {
        return Response.json({ error: "TeamRuntime and EventRuntime must be bound" }, { status: 503 });
      }
      const key = teamSeedKey(teamKey, year);
      const current = await this.storage.get<TeamSeedJob>(key);
      if (current?.status === "running") return Response.json(current, { status: 202, headers: { "Cache-Control": "no-store" } });
      const now = Date.now();
      const job: TeamSeedJob = {
        teamKey, year, status: "running", stage: "seed", eventKeys: [], events: [],
        eventCursor: 0, waitStartedAt: now, attempts: 0, scheduledEvents: 0,
        errors: [], startedAt: now, updatedAt: now, nextDueAt: now,
      };
      await this.storage.put(key, job);
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
        return Response.json(seasonIngestSummary(job), { status: 202, headers: { "Cache-Control": "no-store" } });
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
      if (!audit || !["running", "paused"].includes(audit.status)) return Response.json(audit ?? { error: "Coverage audit has not been started" }, { status: 409 });
      audit.status = "running";
      audit.updated_at = Date.now();
      await this.storage.put(storageKey, audit);
      await this.storage.setAlarm(Date.now());
      const { event_keys: _eventKeys, team_keys: _teamKeys, ...summary } = audit;
      return Response.json({ ...summary, processed: audit.cursor, total: audit.event_keys.length + audit.team_keys.length,
        remaining: Math.max(0, audit.event_keys.length + audit.team_keys.length - audit.cursor), queued: true },
        { status: 202, headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "GET" && url.pathname === "/admin/overview") {
      const currentSeasonYear = new Date().getUTCFullYear();
      const currentSeasonIndex = await this.storage.get<DiscoveryCache>(DISCOVERY_PREFIX + currentSeasonYear);
      const currentSeasonCheckedAt = currentSeasonIndex?.checkedAt ?? currentSeasonIndex?.updatedAt ?? null;
      const currentSeasonIndexStatus = !currentSeasonIndex ? "missing"
        : currentSeasonCheckedAt !== null && Date.now() - currentSeasonCheckedAt > eventPollingPolicy(this.env).discoveryIntervalMs
          ? "stale" : "available";
      const eventKeys = [...new Set([
        ...(await this.storage.get<string[]>("registry:events") ?? []),
        ...(await this.storage.get<string[]>("scheduler:event-keys") ?? []),
      ])].sort();
      const teamKeys = [...new Set(await this.storage.get<string[]>("registry:teams") ?? [])].sort();
      // The overview is deliberately metadata-only. Never fan out to dozens of
      // EventRuntime/TeamRuntime objects during a dashboard refresh; inspect a
      // single runtime only when an operator opens its command center.
      const events: unknown[] = [];
      const teams: unknown[] = [];
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
          current_season_index: {
            year: currentSeasonYear,
            status: currentSeasonIndexStatus,
            persisted: Boolean(currentSeasonIndex),
            event_count: currentSeasonIndex?.events.length ?? 0,
            updated_at: currentSeasonIndex?.updatedAt ?? null,
            checked_at: currentSeasonCheckedAt,
            revalidation_pending: false,
            revalidation_owner: "fieldview-jobs",
            last_error: await this.storage.get<string>("scheduler:current-season-index-error") ?? null,
          },
        },
        events, teams, multiplexer,
        truncated: false,
        inventory: { events: eventKeys.length, teams: teamKeys.length },
      });
    }

    if (currentAlarm === null || currentAlarm === undefined || currentAlarm > Date.now()) {
        await this.storage.setAlarm(Date.now() + 100);
      }
      return Response.json({ queued: true, pending: true }, { status: 202 });
    }

    if (request.method === "POST" && url.pathname === "/run") {
      const activeJobs = await this.storage.list<SeasonIngestJob>({ prefix: "admin:season-ingest:" });
      if ([...activeJobs.values()].some((job) => job.status === "running" || job.status === "paused")) {
        return Response.json({ error: "Pause/resume or cancel the season-ingest job before running discovery manually." }, { status: 409 });
      }
      const year = new Date().getUTCFullYear();
      const key = adminDiscoveryKey("current", year);
      const current = await this.storage.get<AdminDiscoveryJob>(key);
      if (current?.status === "running") return Response.json(current, { status: 202 });
      const now = Date.now();
      const job: AdminDiscoveryJob = {
        year, mode: "current", status: "running", stage: "events",
        events: 0, teams: 0, steps: 0, error: null,
        startedAt: now, updatedAt: now, nextDueAt: now,
      };
      await this.storage.put(key, job);
      await this.storage.setAlarm(now);
      return Response.json(job, { status: 202, headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "POST" && url.pathname === "/start") {
      await this.storage.put("scheduler:enabled", true);
      await this.storage.setAlarm(Date.now());
      return Response.json({ started: true });
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      await this.storage.put("scheduler:enabled", false);
      const [eventSeeds, teamSeeds, seasonJobs, discoveryJobs, audits] = await Promise.all([
        this.storage.list<EventTeamSeedJob>({ prefix: "admin:event-team-seed:" }),
        this.storage.list<TeamSeedJob>({ prefix: "admin:team-seed:" }),
        this.storage.list<SeasonIngestJob>({ prefix: "admin:season-ingest:" }),
        this.storage.list<AdminDiscoveryJob>({ prefix: "admin:discovery-job:" }),
        this.storage.list<CoverageAuditRecord>({ prefix: "admin:coverage-audit:" }),
      ]);
      const pending = [...eventSeeds.values()].some((job) => job.status === "running") ||
        [...teamSeeds.values()].some((job) => job.status === "running") ||
        [...seasonJobs.values()].some((job) => job.status === "running") ||
        [...discoveryJobs.values()].some((job) => job.status === "running") ||
        [...audits.values()].some((job) => job.status === "running");
      if (pending) await this.storage.setAlarm(Date.now() + 100);
      else await this.storage.deleteAlarm();
      return Response.json({ started: false, admin_jobs_continuing: pending });
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
    if (job.stage !== "discover" && job.cursor >= job.teamKeys.length) {
      job.status = job.failedTeams > 0 ? "completed_with_errors" : "completed";
      job.activeTeamKey = null; job.updatedAt = Date.now();
      await this.storage.put(eventTeamSeedKey(job.eventKey), job); return;
    }
    if (job.stage === "discover") {
      try {
        const response = await this.api.request(TBA_ENDPOINTS.eventTeams(job.eventKey));
        if (!response.ok) throw new Error("Unable to retrieve event participants (HTTP " + response.status + ")");
        const participants = await response.json() as TBATeam[];
        if (!Array.isArray(participants)) throw new Error("TBA event participants response was not an array");
        job.teamKeys = [...new Set(participants.map((team) => team.key).filter((key): key is string =>
          typeof key === "string" && /^frc\d+$/.test(key)))].sort();
        if (job.teamKeys.length === 0) throw new Error("No valid participant teams were returned for this event");
        job.stage = "seed";
        job.teamAttempts = 0;
        job.nextDueAt = Date.now() + 100;
      } catch (error) {
        job.teamAttempts += 1;
        job.errors.push({ team_key: job.eventKey, detail: error instanceof Error ? error.message : String(error), at: Date.now() });
        if (job.teamAttempts >= 5) job.status = "completed_with_errors";
        else job.nextDueAt = Date.now() + Math.min(30_000, 1_000 * (2 ** job.teamAttempts));
      }
      job.updatedAt = Date.now();
      await this.storage.put(eventTeamSeedKey(job.eventKey), job);
      return;
    }
    const teamKey = job.teamKeys[job.cursor];
    job.activeTeamKey = teamKey;
    job.teamWaitStartedAt ??= Date.now();
    const headers = { Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Team-Key": teamKey };
    try {
      const stub = this.env.TEAM_RUNTIME.get(this.env.TEAM_RUNTIME.idFromName(teamKey));
      if (job.stage === "seed") {
        const registry = await this.storage.get<string[]>("registry:teams") ?? [];
        if (!registry.includes(teamKey)) await this.storage.put("registry:teams", [...registry, teamKey].sort());
        const response = await stub.fetch(new Request("https://team-runtime/seed?year=" + job.year, { method: "POST", headers }));
        if (!response.ok) throw new Error("TeamRuntime seed returned HTTP " + response.status);
        // Team history is a hard dependency for this job. Explicitly enqueue that
        // resource after the general team seed so it is prioritized over the
        // remaining team resources when the manual queue is drained.
        const historyResource = teamResourceEndpoints(teamKey, job.year).find((resource) =>
          resource.provider === "tba" && resource.endpoint === TBA_ENDPOINTS.teamEvents(teamKey, job.year));
        if (!historyResource) throw new Error("Team event-history resource is not configured");
        const stateResponse = await stub.fetch(new Request("https://team-runtime/state", { headers }));
        if (!stateResponse.ok) throw new Error("TeamRuntime state returned HTTP " + stateResponse.status);
        const teamState = await stateResponse.json() as {
          endpoints?: Array<{ endpoint?: string; last_fetched_at?: number | null; lastFetchedAt?: number | null }>;
        };
        const historyState = teamState.endpoints?.find((endpoint) => endpoint.endpoint === historyResource.endpoint);
        if ((historyState?.last_fetched_at ?? historyState?.lastFetchedAt ?? null) === null) {
          const historyResponse = await stub.fetch(new Request("https://team-runtime/ingest-resource?year=" + job.year, {
            method: "POST", headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: historyResource.endpoint }),
          }));
          if (!historyResponse.ok) throw new Error("TeamRuntime event-history curation returned HTTP " + historyResponse.status);
        }
        job.stage = "wait";
        job.teamWaitStartedAt = Date.now();
        job.nextDueAt = Date.now() + 2_000;
      } else {
        const stateResponse = await stub.fetch(new Request("https://team-runtime/state", { headers }));
        if (!stateResponse.ok) throw new Error("TeamRuntime state returned HTTP " + stateResponse.status);
        const teamState = await stateResponse.json() as {
          endpoints?: Array<{ endpoint?: string; status?: string; last_fetched_at?: number | null; lastFetchedAt?: number | null }>;
        };
        const historyEndpoint = TBA_ENDPOINTS.teamEvents(teamKey, job.year);
        const historyState = teamState.endpoints?.find((endpoint) => endpoint.endpoint === historyEndpoint);
        const historyFetchedAt = historyState?.last_fetched_at ?? historyState?.lastFetchedAt ?? null;
        if (historyState?.status === "unavailable") {
          throw new Error("Team event history is unavailable from The Blue Alliance (HTTP 404)");
        }
        if (historyFetchedAt === null) {
          const elapsed = Date.now() - (job.teamWaitStartedAt ?? job.startedAt);
          if (elapsed >= 15 * 60_000) throw new Error("Timed out waiting for immediate team event-history curation after 15 minutes");
          // Re-enqueue if the manual queue exhausted its own transient retries.
          // The queue deduplicates by endpoint; retry after a short backoff.
          const retryResponse = await stub.fetch(new Request("https://team-runtime/ingest-resource?year=" + job.year, {
            method: "POST", headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: historyEndpoint }),
          }));
          if (!retryResponse.ok) throw new Error("TeamRuntime event-history retry returned HTTP " + retryResponse.status);
          job.teamAttempts += 1;
          job.nextDueAt = Date.now() + 3_000;
          job.updatedAt = Date.now();
          await this.storage.put(eventTeamSeedKey(job.eventKey), job);
          return;
        }
        const response = await stub.fetch(new Request("https://team-runtime/snapshot?year=" + job.year + "&noSchedule=1", { headers }));
        if (!response.ok) throw new Error("TeamRuntime snapshot returned HTTP " + response.status);
        const snapshot = await response.json() as { events?: Array<Record<string, unknown>> | null };
        if (!Array.isArray(snapshot.events)) throw new Error("Team event history was fetched but is missing from the normalized snapshot");
        const policy = eventPollingPolicy(this.env);
        const eventKeys = snapshot.events.map((event) => event.key).filter((key): key is string =>
          typeof key === "string" && /^[a-zA-Z0-9_-]+$/.test(key));
        if (!job.eventKeys || JSON.stringify(job.eventKeys) !== JSON.stringify(eventKeys)) {
          job.eventKeys = eventKeys;
          job.eventCursor = 0;
        }
        const eventByKey = new Map(snapshot.events.filter((event) => typeof event.key === "string").map((event) => [String(event.key), event]));
        let scheduledThisAlarm = 0;
        for (let eventIndex = job.eventCursor ?? 0; eventIndex < eventKeys.length && scheduledThisAlarm < 10; eventIndex += 1) {
          const event = eventByKey.get(eventKeys[eventIndex]);
          if (!event) { job.eventCursor = eventIndex + 1; continue; }
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
          job.eventCursor = eventIndex + 1;
          scheduledThisAlarm += 1;
        }
        if ((job.eventCursor ?? 0) < eventKeys.length) {
          job.nextDueAt = Date.now() + 100;
          job.updatedAt = Date.now();
          await this.storage.put(eventTeamSeedKey(job.eventKey), job);
          return;
        }
        job.eventKeys = undefined; job.eventCursor = undefined;
        job.seededTeams += 1; job.cursor += 1; job.activeTeamKey = null;
        job.stage = "seed"; job.teamAttempts = 0; job.teamWaitStartedAt = undefined; job.nextDueAt = Date.now() + 100;
      }
    } catch (error) {
      job.teamAttempts += 1;
      const detail = error instanceof Error ? error.message : String(error);
      const elapsed = Date.now() - (job.teamWaitStartedAt ?? job.startedAt);
      const terminalUnavailable = detail.includes("is unavailable from The Blue Alliance");
      if (terminalUnavailable || elapsed >= 15 * 60_000) {
        job.errors.push({ team_key: teamKey, detail: detail.slice(0, 240), at: Date.now() });
        if (job.errors.length > 50) job.errors.splice(0, job.errors.length - 50);
        job.failedTeams += 1; job.cursor += 1; job.activeTeamKey = null;
        job.stage = "seed"; job.teamAttempts = 0; job.teamWaitStartedAt = undefined; job.nextDueAt = Date.now() + 100;
      } else {
        job.nextDueAt = Date.now() + Math.min(30_000, Math.max(2_000, 2_000 * (2 ** Math.min(job.teamAttempts, 4))));
      }
    }
    job.updatedAt = Date.now();
    if (job.cursor >= job.teamKeys.length) {
      job.status = job.failedTeams > 0 ? "completed_with_errors" : "completed"; job.activeTeamKey = null;
    }
    await this.storage.put(eventTeamSeedKey(job.eventKey), job);
  }


  private async processCoverageAuditBatch(year: number): Promise<void> {
    const storageKey = "admin:coverage-audit:" + year;
    const audit = await this.storage.get<CoverageAuditRecord>(storageKey);
    if (!audit || audit.status !== "running") return;
        const all = [...audit.event_keys.map((key) => ({ kind: "event" as const, key })), ...audit.team_keys.map((key) => ({ kind: "team" as const, key }))];
        const registeredEvents = new Set([
          ...(await this.storage.get<string[]>("registry:runtime-events") ?? []),
          ...(await this.storage.get<string[]>("scheduler:event-keys") ?? []),
        ]);
        const registeredTeams = new Set(await this.storage.get<string[]>("registry:teams") ?? []);
        const batch = all.slice(audit.cursor, audit.cursor + 5);
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
        else audit.status = "paused";
        await this.storage.put(storageKey, audit);
  }

  private async processTeamSeed(job: TeamSeedJob): Promise<void> {
    if (!this.env.TEAM_RUNTIME || !this.env.EVENT_RUNTIME) throw new Error("TeamRuntime and EventRuntime must be bound");
    const key = teamSeedKey(job.teamKey, job.year);
    const teamHeaders = {
      Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
      "X-FieldView-Team-Key": job.teamKey,
    };
    try {
      const teamStub = this.env.TEAM_RUNTIME.get(this.env.TEAM_RUNTIME.idFromName(job.teamKey));
      const historyEndpoint = TBA_ENDPOINTS.teamEvents(job.teamKey, job.year);
      if (job.stage === "seed") {
        const registry = await this.storage.get<string[]>("registry:teams") ?? [];
        if (!registry.includes(job.teamKey)) await this.storage.put("registry:teams", [...registry, job.teamKey].sort());
        const response = await teamStub.fetch(new Request("https://team-runtime/seed?year=" + job.year, { method: "POST", headers: teamHeaders }));
        if (!response.ok) throw new Error("TeamRuntime seed returned HTTP " + response.status);
        const historyResource = teamResourceEndpoints(job.teamKey, job.year).find((resource) =>
          resource.provider === "tba" && resource.endpoint === historyEndpoint);
        if (!historyResource) throw new Error("Team event-history resource is not configured");
        const stateResponse = await teamStub.fetch(new Request("https://team-runtime/state", { headers: teamHeaders }));
        if (!stateResponse.ok) throw new Error("TeamRuntime state returned HTTP " + stateResponse.status);
        const state = await stateResponse.json() as { endpoints?: Array<{ endpoint?: string; last_fetched_at?: number | null; lastFetchedAt?: number | null }> };
        const history = state.endpoints?.find((item) => item.endpoint === historyEndpoint);
        if ((history?.last_fetched_at ?? history?.lastFetchedAt ?? null) === null) {
          await teamStub.fetch(new Request("https://team-runtime/ingest-resource?year=" + job.year, {
            method: "POST", headers: { ...teamHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: historyEndpoint }),
          }));
        }
        job.stage = "wait";
        job.waitStartedAt = Date.now();
        job.nextDueAt = Date.now() + 2_000;
      } else if (job.stage === "wait") {
        const stateResponse = await teamStub.fetch(new Request("https://team-runtime/state", { headers: teamHeaders }));
        if (!stateResponse.ok) throw new Error("TeamRuntime state returned HTTP " + stateResponse.status);
        const state = await stateResponse.json() as {
          endpoints?: Array<{ endpoint?: string; status?: string; last_fetched_at?: number | null; lastFetchedAt?: number | null }>;
        };
        const history = state.endpoints?.find((item) => item.endpoint === historyEndpoint);
        if (history?.status === "unavailable") throw new Error("Team event history is unavailable from The Blue Alliance (HTTP 404)");
        const fetchedAt = history?.last_fetched_at ?? history?.lastFetchedAt ?? null;
        if (fetchedAt === null) {
          if (Date.now() - job.waitStartedAt >= 15 * 60_000) throw new Error("Timed out waiting for TeamRuntime event history after 15 minutes");
          await teamStub.fetch(new Request("https://team-runtime/ingest-resource?year=" + job.year, {
            method: "POST", headers: { ...teamHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: historyEndpoint }),
          }));
          job.attempts += 1;
          job.nextDueAt = Date.now() + Math.min(30_000, 2_000 * (2 ** Math.min(job.attempts, 4)));
        } else {
          const snapshotResponse = await teamStub.fetch(new Request("https://team-runtime/snapshot?year=" + job.year + "&noSchedule=1", { headers: teamHeaders }));
          if (!snapshotResponse.ok) throw new Error("TeamRuntime snapshot returned HTTP " + snapshotResponse.status);
          const snapshot = await snapshotResponse.json() as { events?: Array<Record<string, unknown>> | null };
          if (!Array.isArray(snapshot.events)) throw new Error("Team event history is ready but missing from the normalized snapshot");
          job.events = snapshot.events;
          job.eventKeys = snapshot.events.map((event) => event.key).filter((value): value is string =>
            typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value));
          job.eventCursor = 0;
          job.stage = "events";
          job.nextDueAt = Date.now() + 100;
        }
      } else {
        const policy = eventPollingPolicy(this.env);
        const eventByKey = new Map(job.events.filter((event) => typeof event.key === "string").map((event) => [String(event.key), event]));
        const batch = job.eventKeys.slice(job.eventCursor, job.eventCursor + 10);
        const knownEvents = new Set(await this.storage.get<string[]>("registry:events") ?? []);
        const runtimeEvents = new Set(await this.storage.get<string[]>("registry:runtime-events") ?? []);
        for (const eventKey of batch) {
          const event = eventByKey.get(eventKey);
          if (!event) { job.eventCursor += 1; continue; }
          const lifecycle = classifyEventLifecycle({
            start_date: String(event.start_date ?? ""), end_date: String(event.end_date ?? ""),
            timezone: String(event.timezone ?? ""),
          }, Date.now(), policy);
          const stub = this.env.EVENT_RUNTIME.get(this.env.EVENT_RUNTIME.idFromName(eventKey));
          const headers = {
            Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
            "X-FieldView-Event-Key": eventKey, "Content-Type": "application/json",
          };
          const response = !lifecycle || lifecycle.lifecycle === "expired"
            ? await stub.fetch(new Request("https://event-runtime/schedule", {
                method: "POST", headers,
                body: JSON.stringify({ endpoints: eventResourceEndpoints(eventKey), intervalMs: 86_400_000, analyticsEnabled: false }),
              }))
            : await stub.fetch(new Request("https://event-runtime/lifecycle", {
                method: "POST", headers,
                body: JSON.stringify({
                  lifecycle: lifecycle.lifecycle, upcomingIntervalMs: policy.upcomingIntervalMs,
                  activeIntervalMs: policy.activeIntervalMs,
                  ...(lifecycle.completedUntil === null ? {} : { completedUntil: lifecycle.completedUntil }),
                }),
              }));
          if (!response.ok) job.errors.push({ event_key: eventKey, detail: "EventRuntime returned HTTP " + response.status, at: Date.now() });
          else { knownEvents.add(eventKey); runtimeEvents.add(eventKey); job.scheduledEvents += 1; }
          job.eventCursor += 1;
        }
        await this.storage.put("registry:events", [...knownEvents].sort());
        await this.storage.put("registry:runtime-events", [...runtimeEvents].sort());
        if (job.eventCursor >= job.eventKeys.length) job.status = job.errors.length ? "completed_with_errors" : "completed";
        else job.nextDueAt = Date.now() + 100;
      }
    } catch (error) {
      job.attempts += 1;
      const detail = error instanceof Error ? error.message : String(error);
      if (job.attempts >= 5 || detail.includes("unavailable from The Blue Alliance")) {
        job.status = "completed_with_errors";
        job.errors.push({ event_key: job.teamKey, detail: detail.slice(0, 240), at: Date.now() });
      } else job.nextDueAt = Date.now() + Math.min(30_000, 1_000 * (2 ** job.attempts));
    }
    job.updatedAt = Date.now();
    await this.storage.put(key, job);
  }

  private async processAdminDiscovery(job: AdminDiscoveryJob): Promise<void> {
    const key = adminDiscoveryKey(job.mode, job.year);
    job.steps += 1;
    try {
      if (job.mode === "year") {
        if (job.stage === "events") {
          await this.discoverEvents(job.year);
          const cache = await this.storage.get<DiscoveryCache>(ADMIN_DISCOVERY_PREFIX + job.year);
          job.events = cache?.events.length ?? 0;
          job.stage = "teams";
        } else if (job.stage === "teams") {
          const result = await this.discoverTeams(job.year, ADMIN_TEAM_DISCOVERY_PREFIX, 4);
          job.teams = result.teamCount;
          if (result.complete) job.stage = "complete";
        }
      } else {
        const policy = eventPollingPolicy(this.env);
        if (job.stage === "events" || job.stage === "lifecycle") {
          await this.measureStage("event-discovery-and-lifecycle", () => this.discoverAndSchedule(policy));
          const cache = await this.storage.get<DiscoveryCache>(DISCOVERY_PREFIX + job.year);
          job.events = cache?.events.length ?? 0;
          if (await this.storage.get<{ cursor: number }>("scheduler:event-lifecycle-progress")) job.stage = "lifecycle";
          else job.stage = "teams";
        } else if (job.stage === "teams") {
          const result = await this.discoverTeams(job.year, TEAM_DISCOVERY_PREFIX, 4);
          job.teams = result.teamCount;
          if (result.complete) job.stage = "this-week";
        } else if (job.stage === "this-week") {
          const pending = await this.measureStage("this-week-event-classification", () => this.refreshThisWeekProjection(policy));
          if (!pending) job.stage = "complete";
        }
      }
      if (job.stage === "complete") {
        job.status = "completed";
        if (job.mode === "current") await this.storage.put("scheduler:last-run-at", Date.now());
      } else job.nextDueAt = Date.now() + 1_000;
      job.error = null;
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      job.status = "failed";
    }
    job.updatedAt = Date.now();
    await this.storage.put(key, job);
  }

  async alarm(): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.handleAlarm();
    } finally {
      console.log("[FV][TaskScheduler] alarm", JSON.stringify({
        duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
      }));
    }
  }

  private async handleAlarm(): Promise<void> {
    // Current-season discovery and this-week projection are owned by the
    // fieldview-jobs Workflow; this DO alarm only advances legacy admin jobs
    // while those responsibilities are being migrated.
    const eventSeedJobs = await this.storage.list<EventTeamSeedJob>({ prefix: "admin:event-team-seed:" });
    const activeEventSeed = [...eventSeedJobs.values()].find((job) => job.status === "running");
    if (activeEventSeed) {
      if (activeEventSeed.nextDueAt <= Date.now()) await this.measureStage("event-team-seed", () => this.processEventTeamSeed(activeEventSeed));
      const refreshed = await this.storage.get<EventTeamSeedJob>(eventTeamSeedKey(activeEventSeed.eventKey));
      if (refreshed?.status === "running") await this.storage.setAlarm(Math.max(Date.now() + 100, refreshed.nextDueAt));
      else await this.storage.setAlarm(Date.now() + 100);
      return;
    }
    const teamSeedJobs = await this.storage.list<TeamSeedJob>({ prefix: "admin:team-seed:" });
    const activeTeamSeed = [...teamSeedJobs.values()].find((job) => job.status === "running");
    if (activeTeamSeed) {
      if (activeTeamSeed.nextDueAt <= Date.now()) await this.measureStage("team-seed", () => this.processTeamSeed(activeTeamSeed));
      const refreshed = await this.storage.get<TeamSeedJob>(teamSeedKey(activeTeamSeed.teamKey, activeTeamSeed.year));
      if (refreshed?.status === "running") await this.storage.setAlarm(Math.max(Date.now() + 100, refreshed.nextDueAt));
      else await this.storage.setAlarm(Date.now() + 100);
      return;
    }
    const activeJob = await this.storage.list<SeasonIngestJob>({ prefix: "admin:season-ingest:" });
    const runningJob = [...activeJob.values()].find((job) => job.status === "running");
    if (runningJob) {
      await this.measureStage("season-ingest", () => this.processSeasonIngest(runningJob));
      const refreshed = await this.storage.get<SeasonIngestJob>(seasonIngestKey(runningJob.year));
      if (refreshed?.status === "running") await this.storage.setAlarm(Math.max(Date.now() + 100, refreshed.nextDueAt ?? Date.now() + 1_000));
      else await this.storage.setAlarm(Date.now() + 100);
      return;
    }
    const coverageAudits = await this.storage.list<CoverageAuditRecord>({ prefix: "admin:coverage-audit:" });
    const activeCoverageAudit = [...coverageAudits.values()].find((audit) => audit.status === "running");
    if (activeCoverageAudit) {
      await this.measureStage("coverage-audit", () => this.processCoverageAuditBatch(activeCoverageAudit.year));
      const refreshed = await this.storage.get<CoverageAuditRecord>("admin:coverage-audit:" + activeCoverageAudit.year);
      if (refreshed?.status === "running") await this.storage.setAlarm(Date.now() + 250);
      else await this.storage.setAlarm(Date.now() + 100);
      return;
    }
    const discoveryJobs = await this.storage.list<AdminDiscoveryJob>({ prefix: "admin:discovery-job:" });
    const activeDiscovery = [...discoveryJobs.values()]
      .filter((job) => job.status === "running")
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (activeDiscovery) {
      await this.measureStage("admin-discovery", () => this.processAdminDiscovery(activeDiscovery));
      const refreshed = await this.storage.get<AdminDiscoveryJob>(adminDiscoveryKey(activeDiscovery.mode, activeDiscovery.year));
      if (refreshed?.status === "running") await this.storage.setAlarm(Math.max(Date.now() + 100, refreshed.nextDueAt));
      else await this.storage.setAlarm(Date.now() + 100);
      return;
    }
    // All recurring discovery and classification now run in fieldview-jobs.
    // Keep the legacy DO alarm only for bounded administrative job cursors.
    await this.storage.deleteAlarm();
  }

  private async refreshThisWeekProjection(policy: EventPollingPolicy): Promise<boolean> {
    const now = Date.now();
    const runDate = new Date(now).toISOString().slice(0, 10);
    const year = Number(runDate.slice(0, 4));
    const discovery = await this.storage.get<DiscoveryCache>(DISCOVERY_PREFIX + year);
    if (!discovery || !Array.isArray(discovery.events)) return false;

    let progress = await this.storage.get<ThisWeekProgress>(THIS_WEEK_PROGRESS_KEY);
    if (progress?.runDate !== runDate) {
      if (await this.storage.get<string>(THIS_WEEK_LAST_RUN_KEY) === runDate) return false;
      progress = {
        runDate,
        eventKeys: discovery.events.map((event) => event.key).filter((key): key is string =>
          typeof key === "string" && /^[a-zA-Z0-9_-]+$/.test(key),
        ).sort(),
        cursor: 0,
        includedKeys: [],
      };
      await this.storage.put(THIS_WEEK_PROGRESS_KEY, progress);
    }

    const eventsByKey = new Map(discovery.events
      .filter((event) => typeof event.key === "string")
      .map((event) => [event.key, event] as const));
    const scheduledKeys = new Set(await this.storage.get<string[]>("scheduler:event-keys") ?? []);
    const runtimeEventKeys = new Set(await this.storage.get<string[]>("registry:runtime-events") ?? []);
    const batch = progress.eventKeys.slice(progress.cursor, progress.cursor + 10);
    for (const eventKey of batch) {
      const event = eventsByKey.get(eventKey);
      if (!event) continue;
      const classification = classifyEventThisWeek(event, now);
      if (!classification?.isThisWeek) continue;
      progress.includedKeys.push(eventKey);

      // A weekly event always gets an EventRuntime, even if its last date has
      // passed earlier in the same Monday-Sunday window. Expired lifecycle
      // state prevents unnecessary polling while retaining the runtime owner.
      const lifecycle = classifyEventLifecycle(event, now, policy);
      const stub = this.env.EVENT_RUNTIME.get(this.env.EVENT_RUNTIME.idFromName(eventKey));
      const eventHeaders = {
        Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
        "X-FieldView-Event-Key": eventKey,
        "Content-Type": "application/json",
      };
      const response = lifecycle
        ? await stub.fetch(new Request("https://event-runtime/lifecycle", {
            method: "POST",
            headers: eventHeaders,
            body: JSON.stringify({
              lifecycle: lifecycle.lifecycle,
              upcomingIntervalMs: policy.upcomingIntervalMs,
              activeIntervalMs: policy.activeIntervalMs,
              ...(lifecycle.completedUntil === null ? {} : { completedUntil: lifecycle.completedUntil }),
            }),
          }))
        : await stub.fetch(new Request("https://event-runtime/schedule", {
            method: "POST",
            headers: eventHeaders,
            body: JSON.stringify({
              endpoints: eventResourceEndpoints(eventKey),
              intervalMs: 86_400_000,
              analyticsEnabled: false,
            }),
          }));
      if (!response.ok) throw new Error("Failed to initialize this-week EventRuntime " + eventKey + ": HTTP " + response.status);
      runtimeEventKeys.add(eventKey);
      if (lifecycle?.lifecycle === "expired") scheduledKeys.delete(eventKey);
      else if (lifecycle) scheduledKeys.add(eventKey);
    }
    progress.cursor += batch.length;
    await this.storage.put(THIS_WEEK_PROGRESS_KEY, progress);
    const nextScheduledKeys = [...scheduledKeys].sort();
    const previousScheduledKeys = await this.storage.get<string[]>("scheduler:event-keys") ?? [];
    if (JSON.stringify(previousScheduledKeys) !== JSON.stringify(nextScheduledKeys)) {
      await this.storage.put("scheduler:event-keys", nextScheduledKeys);
    }
    const nextRuntimeEventKeys = [...runtimeEventKeys].sort();
    const previousRuntimeEventKeys = await this.storage.get<string[]>("registry:runtime-events") ?? [];
    if (JSON.stringify(previousRuntimeEventKeys) !== JSON.stringify(nextRuntimeEventKeys)) {
      await this.storage.put("registry:runtime-events", nextRuntimeEventKeys);
    }

    if (progress.cursor < progress.eventKeys.length) return true;

    const included = new Set(progress.includedKeys);
    const events = discovery.events.filter((event) => typeof event.key === "string" && included.has(event.key));
    const projection = {
      evaluatedAt: now,
      runDate,
      checkedAt: discovery.checkedAt ?? discovery.updatedAt,
      events,
    };
    const previous = await this.storage.get<typeof projection>(THIS_WEEK_PROJECTION_KEY);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(projection)) {
      await this.storage.put(THIS_WEEK_PROJECTION_KEY, projection);
    }
    await this.storage.put(THIS_WEEK_LAST_RUN_KEY, runDate);
    await this.storage.delete(THIS_WEEK_PROGRESS_KEY);
    return false;
  }

  private async measureStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await operation();
      console.log("[FV][TaskScheduler] alarm-stage", JSON.stringify({
        stage, outcome: "success",
        duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
      }));
      return result;
    } catch (error) {
      console.error("[FV][TaskScheduler] alarm-stage", JSON.stringify({
        stage, outcome: "error",
        duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
        error: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }
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
          // Team registration is persisted before the seed starts; do not rewrite it again on completion.
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
    const response = await this.api.request(TBA_ENDPOINTS.events(year), { headers });
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
    const pagePrefix = cache.pagePrefix ?? key + ":page:";
    for (let page = 0; page < (cache.pageCount ?? 0); page += 1) {
      const values = await this.storage.get<TBATeam[]>(pagePrefix + page);
      if (!values) return null;
      teams.push(...values);
    }
    return teams;
  }

  private async discoverTeams(
    year: number,
    prefix = TEAM_DISCOVERY_PREFIX,
    maxPages = 100,
  ): Promise<{ requestCount: number; pageCount: number; teamCount: number; complete: boolean }> {
    const key = prefix + year;
    const cached = await this.storage.get<TeamDiscoveryCache>(key);
    const refreshKey = key + ":refresh";
    const storedRefresh = await this.storage.get<{ cursor: number; pageEtags: Record<string, string | null>; payloadChanged: boolean }>(refreshKey);
    const lastCheckedAt = cached?.checkedAt ?? cached?.updatedAt ?? 0;
    if (prefix === TEAM_DISCOVERY_PREFIX && cached?.complete === true && !storedRefresh &&
        Date.now() - lastCheckedAt < eventPollingPolicy(this.env).discoveryIntervalMs) {
      return {
        requestCount: 0, pageCount: cached.pageCount ?? 0,
        teamCount: cached.teamCount ?? cached.teamKeys?.length ?? 0, complete: true,
      };
    }
    const refresh = storedRefresh ?? { cursor: 0, pageEtags: {}, payloadChanged: !cached?.complete };
    let requestCount = 0;
    let complete = false;
    let cursor = refresh.cursor;
    const pageLimit = Math.max(1, Math.min(100, maxPages));

    // Routine scheduler runs process a bounded number of pages. Staging pages
    // are separate from the published cache, so public reads keep seeing the
    // last complete inventory until the replacement is complete.
    while (cursor < 100 && requestCount < pageLimit) {
      const pageKey = String(cursor);
      const cachedPage = await this.storage.get<TBATeam[]>(key + ":refresh:page:" + cursor) ??
        await this.storage.get<TBATeam[]>((cached?.pagePrefix ?? key + ":page:") + cursor) ??
        (cursor === 0 ? cached?.teams : undefined);
      const etag = refresh.pageEtags[pageKey] ?? cached?.pageEtags?.[pageKey] ?? null;
      const headers = new Headers();
      if (etag) headers.set("If-None-Match", etag);
      const endpoint = TBA_ENDPOINTS.teamsByYearPage(year, cursor);
      const response = await this.api.request(endpoint, { headers });
      requestCount += 1;
      let pageTeams: TBATeam[];
      if (response.status === 304) {
        if (!cachedPage) throw new Error("TBA team page " + cursor + " returned 304 without a retained page payload");
        pageTeams = cachedPage;
        refresh.pageEtags[pageKey] = etag;
      } else {
        if (!response.ok) throw new Error("TBA team discovery page " + cursor + " failed for " + year + " with HTTP " + response.status);
        pageTeams = await response.json() as TBATeam[];
        if (!Array.isArray(pageTeams) || pageTeams.length > 500) throw new Error("TBA team discovery page " + cursor + " returned an invalid payload");
        refresh.pageEtags[pageKey] = response.headers.get("ETag");
        refresh.payloadChanged = true;
      }
      if (response.status !== 304) await this.storage.put(key + ":refresh:page:" + cursor, pageTeams);
      cursor += 1;
      // Persist the cursor and validator after each page so a later alarm can
      // resume exactly where it stopped, including after provider deferral.
      await this.storage.put(refreshKey, { ...refresh, cursor });
      if (pageTeams.length < 500) {
        complete = true;
        break;
      }
    }

    if (!complete && cursor >= 100) throw new Error("TBA team discovery exceeded the 100-page safety limit; season inventory is incomplete");
    if (!complete) {
      await this.storage.put(refreshKey, { ...refresh, cursor });
      return { requestCount, pageCount: cursor, teamCount: cached?.teamCount ?? 0, complete: false };
    }

    const pages: TBATeam[][] = [];
    for (let page = 0; page < cursor; page += 1) {
      const values = await this.storage.get<TBATeam[]>(key + ":refresh:page:" + page) ??
        await this.storage.get<TBATeam[]>((cached?.pagePrefix ?? key + ":page:") + page);
      if (!values) throw new Error("TBA team discovery staging page " + page + " is missing");
      pages.push(values);
    }
    const teams = [...new Map(pages.flat().filter((team) => typeof team?.key === "string" && /^frc[0-9]+$/.test(team.key)).map((team) => [team.key, team])).values()];
    if (teams.length === 0) throw new Error("TBA returned zero teams for " + year + "; refusing to mark the season inventory complete");

    // Publish a new immutable page generation, then atomically switch the
    // metadata pointer. Concurrent public reads continue using the old
    // generation until the complete replacement is visible.
    const checkedAt = Date.now();
    const reusePublishedGeneration = !refresh.payloadChanged && Boolean(cached?.pagePrefix);
    const pagePrefix = reusePublishedGeneration
      ? cached!.pagePrefix!
      : key + ":snapshot:" + checkedAt + ":page:";
    if (!reusePublishedGeneration) {
      for (let page = 0; page < pages.length; page += 1) await this.storage.put(pagePrefix + page, pages[page]);
    }
    const updatedAt = refresh.payloadChanged ? checkedAt : cached?.updatedAt ?? checkedAt;
    await this.storage.put(key, {
      etag: refresh.pageEtags["0"] ?? null, pageEtags: refresh.pageEtags, pageCount: pages.length, pagePrefix,
      teamCount: teams.length, teamKeys: teams.map((team) => team.key).sort(),
      complete: true, updatedAt, checkedAt,
    } satisfies TeamDiscoveryCache);
    for (let page = 0; page < cursor; page += 1) await this.storage.delete(key + ":refresh:page:" + page);
    await this.storage.delete(refreshKey);
    return { requestCount, pageCount: pages.length, teamCount: teams.length, complete: true };
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
      const checkedAt = cached?.checkedAt ?? cached?.updatedAt ?? 0;
      let discovered: TBAEvent[];
      if (cached && Date.now() - checkedAt < policy.discoveryIntervalMs) {
        // Avoid unnecessary provider requests while the retained event
        // directory is still within its configured freshness interval.
        discovered = cached.events;
      } else {
        const headers = new Headers();
        if (cached?.etag) headers.set("If-None-Match", cached.etag);
        const response = await this.api.request(endpoint, { headers });
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
      }
      for (const event of discovered) if (event.key) events.set(event.key, event);
    }

    const scheduledKeys = new Set(await this.storage.get<string[]>("scheduler:event-keys") ?? []);
    const runtimeEventKeys = new Set(await this.storage.get<string[]>("registry:runtime-events") ?? []);
    const lifecycleProgressKey = "scheduler:event-lifecycle-progress";
    const lifecycleProgress = await this.storage.get<{ year: number; eventKeys: string[]; cursor: number }>(lifecycleProgressKey);
    const lifecycleEventKeys = lifecycleProgress?.year === year ? lifecycleProgress.eventKeys : [...events.keys()].sort();
    let lifecycleCursor = lifecycleProgress?.year === year ? lifecycleProgress.cursor : 0;
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

    const lifecycleBatch = lifecycleEventKeys.slice(lifecycleCursor, lifecycleCursor + 10);
    for (const eventKey of lifecycleBatch) {
      const event = events.get(eventKey);
      if (!event) continue;
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
    lifecycleCursor += lifecycleBatch.length;
    await this.storage.put("scheduler:event-keys", [...scheduledKeys]);
    await this.storage.put("registry:runtime-events", [...runtimeEventKeys].sort());
    if (lifecycleCursor < lifecycleEventKeys.length) {
      await this.storage.put(lifecycleProgressKey, { year, eventKeys: lifecycleEventKeys, cursor: lifecycleCursor });
    } else {
      await this.storage.delete(lifecycleProgressKey);
    }
  }
}
