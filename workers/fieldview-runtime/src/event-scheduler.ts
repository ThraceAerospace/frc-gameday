import { TBAApiClient } from "../../../packages/providers/tba/src/client.ts";
import { TBA_ENDPOINTS } from "../../../packages/providers/tba/src/endpoints.ts";
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
        counts: { events_total: number; events_happened: number; events_active: number; events_upcoming: number; events_invalid_dates: number; teams_total: number; team_pages: number; event_runtime_missing: number; team_runtime_missing: number; event_analytics_missing: number; event_resources_incomplete: number; team_resources_incomplete: number; read_errors: number };
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
        counts: { events_total: number; teams_total: number; team_pages: number; event_runtime_missing: number; team_runtime_missing: number; event_analytics_missing: number; event_resources_incomplete: number; team_resources_incomplete: number; read_errors: number };
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
          counts: { events_total: eventKeys.length, ...eventCounts, teams_total: teamKeys.length, team_pages: teamDiscovery.pageCount ?? 0, event_runtime_missing: 0, team_runtime_missing: 0, event_analytics_missing: 0, event_resources_incomplete: 0, team_resources_incomplete: 0, read_errors: 0 },
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
            continue;
          }
          if (!isEvent && !registeredTeams.has(item.key)) {
            audit.counts.team_runtime_missing += 1;
            continue;
          }
          if (!isEvent && !this.env.TEAM_RUNTIME) {
            audit.counts.team_runtime_missing += 1;
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
            if (isEvent) audit.counts.event_runtime_missing += 1;
            else audit.counts.team_runtime_missing += 1;
            continue;
          }
          const state = await response.json() as {
            endpoints?: Record<string, { lastFetchedAt?: number | null; last_fetched_at?: number | null }> |
              Array<{ lastFetchedAt?: number | null; last_fetched_at?: number | null }>;
            analytics?: { status?: string };
          };
          const endpointStates = Array.isArray(state.endpoints) ? state.endpoints : Object.values(state.endpoints ?? {});
          const acquiredResources = endpointStates.filter((resource) =>
            resource.lastFetchedAt != null || resource.last_fetched_at != null).length;
          if (isEvent) {
            if (acquiredResources < 13) audit.counts.event_resources_incomplete += 1;
            if (!["succeeded", "partial"].includes(state.analytics?.status ?? "")) audit.counts.event_analytics_missing += 1;
          } else if (acquiredResources < 7) audit.counts.team_resources_incomplete += 1;
        } catch {
          audit.counts.read_errors += 1;
          if (item.kind === "event") audit.counts.event_runtime_missing += 1;
          else audit.counts.team_runtime_missing += 1;
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

  async alarm(): Promise<void> {
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
      const response = await this.api.request(TBA_ENDPOINTS.teamsByYearPage(year, page), { headers });
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
      const response = await this.api.request(endpoint, { headers });
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
