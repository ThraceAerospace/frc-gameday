import { TBAApiClient } from "../../../packages/providers/tba/src/client.ts";
import { TBA_ENDPOINTS } from "../../../packages/providers/tba/src/endpoints.ts";
import { STATBOTICS_ENDPOINTS } from "../../../packages/providers/statbotics/src/endpoints.ts";
import { eventResourceEndpoints } from "./event-runtime.ts";
import { teamResourceEndpoints } from "./team-runtime.ts";
import type { TBAEvent, TBATeam } from "../../../packages/providers/tba/src/types.ts";
import type { DurableObjectStateLike, RuntimeEnvironment } from "./cloudflare.ts";

export interface EventPollingPolicy {
  upcomingIntervalMs: number;
  activeIntervalMs: number;
  completedRetentionMs: number;
}

export const DEFAULT_EVENT_POLLING_POLICY: EventPollingPolicy = {
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
  year: number;
  events: TBAEvent[];
  updatedAt: number;
  checkedAt?: number;
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
  pageCount: number;
  teamCount: number;
  teamKeys: string[];
  updatedAt: number;
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



/** Season ingestion and cross-runtime team/event seed coordinator; entity runtimes execute dispatched work. */
export class TaskScheduler {
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

  private async readR2Json<T>(key: string): Promise<T | undefined> {
    const object = await this.env.DISCOVERY_BUCKET?.get(key);
    if (!object) return undefined;
    try { return await object.json<T>(); }
    catch { return undefined; }
  }

  private async readR2Keys(key: string): Promise<string[]> {
    const value = await this.readR2Json<unknown>(key);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  }

  private async readEventDiscovery(year: number): Promise<DiscoveryCache | undefined> {
    const directory = await this.readR2Json<DiscoveryCache>(`discovery/events/${year}.json`);
    if (!directory || directory.year !== year || !Array.isArray(directory.events) ||
        directory.events.some((event) => typeof event?.key !== "string")) return undefined;
    return directory;
  }

  private async readTeamDiscovery(year: number): Promise<TeamDiscoveryCache | undefined> {
    const manifest = await this.readR2Json<{
      year: number; pageCount: number; teamCount: number; updatedAt: number;
    }>(`discovery/teams/${year}.json`);
    if (!manifest || manifest.year !== year || !Number.isInteger(manifest.pageCount) ||
        manifest.pageCount < 1 || !Number.isInteger(manifest.teamCount) || manifest.teamCount < 1) return undefined;
    const teamKeys = await this.readR2Keys(`registry/teams/${year}.json`);
    if (teamKeys.length !== manifest.teamCount || teamKeys.some((key) => !/^frc[0-9]+$/.test(key))) return undefined;
    return {
      pageCount: manifest.pageCount, teamCount: manifest.teamCount, teamKeys, updatedAt: manifest.updatedAt,
    };
  }

  private async readRuntimeRegistry(kind: "event" | "team"): Promise<string[]> {
    const bucket = this.env.DISCOVERY_BUCKET;
    if (!bucket) return [];
    const prefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const object of page.objects) {
        const name = object.key.slice(prefix.length).replace(/\.json$/, "");
        if (name) keys.push(name);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys.sort();
  }

  private async registerRuntimeKey(kind: "event" | "team", key: string): Promise<void> {
    if (!this.env.DISCOVERY_BUCKET) return;
    const prefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
    await this.env.DISCOVERY_BUCKET.put(prefix + key + ".json", "{}", {
      httpMetadata: { contentType: "application/json" },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const startedAt = performance.now();
    const url = new URL(request.url);
    try {
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
    const authorized = Boolean(this.env.RUNTIME_ADMIN_TOKEN) &&
      request.headers.get("Authorization") === "Bearer " + this.env.RUNTIME_ADMIN_TOKEN;
    if (!authorized) return Response.json({ error: "Unauthorized" }, { status: 401 });

 
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
        const events = await this.readEventDiscovery(year);
        const teams = await this.readTeamDiscovery(year);
        const eventKeys = events?.events.map((item) => item.key).filter((item): item is string =>
          typeof item === "string" && /^[a-zA-Z0-9_-]+$/.test(item)) ?? [];
        const teamKeys = (teams?.teamKeys ?? []).filter((teamKey) => /^frc\d+$/.test(teamKey));
        const runtimeReady = Boolean(this.env.TEAM_RUNTIME && this.env.EVENT_RUNTIME && this.env.RUNTIME_ADMIN_TOKEN && this.env.TBA_API_KEY);
        const discoveryReady = events !== undefined && teams !== undefined && eventKeys.length > 0 && teamKeys.length > 0;
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
        const events = await this.readEventDiscovery(year);
        const teams = await this.readTeamDiscovery(year);
        if (!events || !teams || !teams.teamKeys.length) {
          return Response.json({ error: "Complete event discovery and paginated team discovery before starting ingestion" }, { status: 409 });
        }
        const eventKeys = [...new Set(events.events.map((event) => event.key).filter((eventKey): eventKey is string => typeof eventKey === "string" && /^[a-zA-Z0-9_-]+$/.test(eventKey)))].sort();
        const teamKeys = [...new Set(teams.teamKeys.filter((teamKey) => /^frc\d+$/.test(teamKey)))].sort();
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
        const currentEvents = await this.readEventDiscovery(year);
        const currentTeams = await this.readTeamDiscovery(year);
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
      if (job.status !== "running") await this.storage.deleteAlarm();
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
      const discovery = kind === "event" ? await this.readEventDiscovery(year) : await this.readTeamDiscovery(year);
      const r2DiscoveredKeys = kind === "event"
        ? (discovery as DiscoveryCache | undefined)?.events.map((item) => item.key) ?? []
        : (discovery as TeamDiscoveryCache | undefined)?.teamKeys ?? [];
      const registered = [...new Set([
        ...(await this.storage.get<string[]>(storageKey) ?? []),
        ...r2DiscoveredKeys,
      ])];

      const keys = registered
        .filter((key) => key.toLowerCase().includes(query)).sort();
      return Response.json({
        kind, year, query, total: keys.length, cursor,
        discovery_ready: discovery !== undefined,
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
      const discovery = kind === "event" ? await this.readEventDiscovery(year) : await this.readTeamDiscovery(year);
      const r2DiscoveredKeys = kind === "event"
        ? (discovery as DiscoveryCache | undefined)?.events.map((item) => item.key) ?? []
        : (discovery as TeamDiscoveryCache | undefined)?.teamKeys ?? [];
      const registered = [...new Set([
        ...(await this.storage.get<string[]>(registryKey) ?? []),
        ...r2DiscoveredKeys,
      ])];
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

    if (request.method === "GET" && url.pathname === "/admin/overview") {
      const currentSeason = await this.readR2Json<{ year: number }>("discovery/current-season.json");
      const currentSeasonYear = currentSeason?.year ?? null;
      const currentSeasonIndex = currentSeasonYear === null
        ? undefined
        : await this.readR2Json<DiscoveryCache>(`discovery/events/${currentSeasonYear}.json`);
      const currentTeamDirectory = currentSeasonYear === null
        ? undefined
        : await this.readR2Json<{ year: number }>(`discovery/teams/${currentSeasonYear}.json`);
      const eventKeys = [...new Set([
        ...(currentSeasonIndex ? await this.readR2Keys(`registry/events/${currentSeasonYear}.json`) : []),
        ...(await this.readRuntimeRegistry("event")),
      ])].sort();
      const teamKeys = [...new Set([
        ...(await this.storage.get<string[]>("registry:teams") ?? []),
        ...(currentTeamDirectory?.year === currentSeasonYear
          ? await this.readR2Keys(`registry/teams/${currentSeasonYear}.json`) : []),
      ])].sort();
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
        current_season: {
          year: currentSeasonYear,
          status: !currentSeasonIndex ? "missing" :
            Date.now() - (currentSeasonIndex.checkedAt ?? currentSeasonIndex.updatedAt) > 36 * 60 * 60_000 ? "stale" : "available",
          event_count: currentSeasonIndex?.events.length ?? 0,
          updated_at: currentSeasonIndex?.updatedAt ?? null,
          checked_at: currentSeasonIndex?.checkedAt ?? null,
        },
        events, teams, multiplexer,
        truncated: false,
        inventory: { events: eventKeys.length, teams: teamKeys.length },
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
        await this.registerRuntimeKey("team", teamKey);
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
          await this.registerRuntimeKey("event", eventKey);
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
        await this.registerRuntimeKey("team", job.teamKey);
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
    // Discovery and event lifecycle scheduling are owned by fieldview-jobs.
    // This alarm advances only explicit administrative jobs.
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
    await this.storage.deleteAlarm();
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
    const currentEventDiscovery = await this.readEventDiscovery(job.year);
    const currentTeamDiscovery = await this.readTeamDiscovery(job.year);
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
        await this.registerRuntimeKey("team", teamKey);
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
        const eventDiscovery = await this.readEventDiscovery(job.year);
        const event = eventDiscovery?.events.find((item) => item.key === eventKey);
        const stub = this.env.EVENT_RUNTIME.get(this.env.EVENT_RUNTIME.idFromName(eventKey));
        const registryEvents = await this.storage.get<string[]>("registry:events") ?? [];
        if (!registryEvents.includes(eventKey)) await this.storage.put("registry:events", [...registryEvents, eventKey].sort());
        await this.registerRuntimeKey("event", eventKey);
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
          const registryEvents = await this.storage.get<string[]>("registry:events") ?? [];
          if (!registryEvents.includes(eventKey)) await this.storage.put("registry:events", [...registryEvents, eventKey].sort());
        await this.registerRuntimeKey("event", eventKey);
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



}
