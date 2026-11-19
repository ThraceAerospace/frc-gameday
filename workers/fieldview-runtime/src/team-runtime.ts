import { TBAApiClient } from "../../../packages/providers/tba/src/client.ts";
import { TBA_ENDPOINTS } from "../../../packages/providers/tba/src/endpoints.ts";
import { StatboticsApiClient } from "../../../packages/providers/statbotics/src/client.ts";
import { STATBOTICS_ENDPOINTS } from "../../../packages/providers/statbotics/src/endpoints.ts";
import type { StatboticsTeamEvent, StatboticsTeamYear } from "../../../packages/providers/statbotics/src/types.ts";
import { applyPollResponse, createEndpointState, createPollRequestSnapshot, type EndpointState } from "./endpoint-state.ts";
import type { DurableObjectStateLike, DurableObjectTransactionLike, RuntimeEnvironment } from "./cloudflare.ts";
import type { TBADistrict, TBAMedia, TBAEvent, TBATeam } from "../../../packages/providers/tba/src/types.ts";
import type { FieldViewSourceRecordMetadata } from "../../../packages/domain/src/source-metadata.ts";
import { normalizeFieldViewTeamSnapshot } from "../../../packages/domain/src/normalization/team-snapshot.ts";

interface TeamPollTask { endpoint: string; dueAt: number; intervalMs: number; attempts: number; }
interface TeamEndpointState<T> extends EndpointState<T> {
  lastHttpStatus?: number | null;
  lastError?: string | null;
}
const TASK_PREFIX = "task:";
const ENDPOINT_PREFIX = "endpoint:";
const DAY_MS = 86_400_000;
const endpointKey = (endpoint: string) => ENDPOINT_PREFIX + endpoint;
const taskKey = (endpoint: string) => TASK_PREFIX + endpoint;
const validKey = (value: string) => /^[a-zA-Z0-9_-]+$/.test(value);

function maxAge(value: string | null): number | null {
  const directive = value?.split(",").map((part) => part.trim()).find((part) => part.toLowerCase().startsWith("max-age="));
  if (!directive) return null;
  const seconds = Number(directive.slice(8).replace(/"/g, ""));
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}
function metadata(state: EndpointState<unknown> | undefined, now: number): FieldViewSourceRecordMetadata | undefined {
  if (!state || state.status === "unknown") return undefined;
  if (state.status === "failed" || state.status === "unavailable") return { status: state.status, retrieved_at: null };
  const retrieved = state.lastFetchedAt ?? state.lastWebhookAt;
  if (retrieved === null) return { status: "failed", retrieved_at: null };
  return {
    status: state.status === "stale" || (state.expiresAt !== null && state.expiresAt < now) ? "stale" : "available",
    retrieved_at: new Date(retrieved).toISOString(),
    ...(state.etag === null ? {} : { validator: state.etag }),
  };
}
function acquired(state: EndpointState<unknown> | undefined): boolean {
  return Boolean(state && state.lastFetchedAt !== null);
}

/** One lazy, independently refreshed Durable Object per TBA team key. */
export class TeamRuntime {
  private readonly storage: DurableObjectStateLike["storage"];
  private readonly api: TBAApiClient;
  private readonly statboticsApi: StatboticsApiClient;
  private readonly env: RuntimeEnvironment;
  private teamKey: string;
  constructor(state: DurableObjectStateLike, env: RuntimeEnvironment, teamKey = "") {
    this.storage = state.storage; this.env = env; this.teamKey = teamKey;
    this.api = new TBAApiClient({ apiKey: env.TBA_API_KEY, ...(env.fetcher ? { fetch: env.fetcher } : {}) });
    this.statboticsApi = new StatboticsApiClient({
      ...(env.STATBOTICS_API_BASE_URL ? { baseUrl: env.STATBOTICS_API_BASE_URL } : {}),
      ...(env.fetcher ? { fetch: env.fetcher } : {}),
    });
  }
  private refreshIntervalMs(): number {
    const configured = this.env.TEAM_REFRESH_INTERVAL_MS;
    const interval = configured === undefined ? DAY_MS : Number(configured);
    if (!Number.isSafeInteger(interval) || interval < 60_000) {
      throw new Error("TEAM_REFRESH_INTERVAL_MS must be an integer of at least 60000");
    }
    return interval;
  }
  private endpoints(year: number): string[] {
    // Public team routes commonly use the numeric team number ("/team/3461"),
    // while TBA v3 requires the provider key ("frc3461").
    const providerTeamKey = /^\d+$/.test(this.teamKey) ? "frc" + this.teamKey : this.teamKey;
    return [TBA_ENDPOINTS.team(providerTeamKey), TBA_ENDPOINTS.teamDistricts(providerTeamKey),
      TBA_ENDPOINTS.teamEvents(providerTeamKey, year), TBA_ENDPOINTS.teamMedia(providerTeamKey, year),
      STATBOTICS_ENDPOINTS.teamYear(Number(providerTeamKey.replace(/^frc/i, "")), year),
      STATBOTICS_ENDPOINTS.teamEvents({ team: Number(providerTeamKey.replace(/^frc/i, "")), year })];
  }
  private async bindTeamKey(request: Request): Promise<boolean> {
    const requested = request.headers.get("X-FieldView-Team-Key");
    if (!requested || !validKey(requested)) return false;
    if (this.teamKey && this.teamKey !== requested) return false;
    const stored = await this.storage.get<string>("team-key");
    if (stored && stored !== requested) return false;
    if (!stored) await this.storage.transaction(async (tx) => {
      const current = await tx.get<string>("team-key");
      if (current && current !== requested) throw new Error("Durable Object team identity mismatch");
      if (!current) await tx.put("team-key", requested);
    });
    this.teamKey = requested; return true;
  }
  private async restoreIdentity(): Promise<boolean> {
    const stored = await this.storage.get<string>("team-key"), key = stored ?? this.teamKey;
    if (!key || !validKey(key)) return false;
    if (this.teamKey && this.teamKey !== key) throw new Error("Durable Object team identity mismatch");
    this.teamKey = key; return true;
  }
  private async rearm(tx: DurableObjectTransactionLike): Promise<void> {
    const tasks = await tx.list<TeamPollTask>({ prefix: TASK_PREFIX });
    const next = [...tasks.values()].reduce<number | null>((value, task) => value === null || task.dueAt < value ? task.dueAt : value, null);
    if (next === null) await tx.deleteAlarm(); else await tx.setAlarm(next);
  }
  private async schedule(year: number, immediate: boolean): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const now = Date.now();
      for (const endpoint of this.endpoints(year)) {
        const key = taskKey(endpoint), previous = await tx.get<TeamPollTask>(key);
        const state = await tx.get<TeamEndpointState<unknown>>(endpointKey(endpoint));
        const needsIngestion = !state || state.status === "unknown" || state.status === "stale" ||
          (state.expiresAt !== null && state.expiresAt < now);
        const dueAt = immediate || (needsIngestion && previous)
          ? now
          : previous?.dueAt ?? now;
        await tx.put(key, { endpoint, dueAt,
          intervalMs: this.refreshIntervalMs(), attempts: immediate ? 0 : previous?.attempts ?? 0 } satisfies TeamPollTask);
      }
      await this.rearm(tx);
    });
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const admin = Boolean(this.env.RUNTIME_ADMIN_TOKEN) && request.headers.get("Authorization") === "Bearer " + this.env.RUNTIME_ADMIN_TOKEN;
    const publicRead = request.method === "GET" && url.pathname === "/snapshot";
    if (!admin && !publicRead) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await this.bindTeamKey(request))) return Response.json({ error: "Invalid or mismatched team identity" }, { status: 400 });
    const yearText = url.searchParams.get("year");
    const year = yearText === null ? new Date().getUTCFullYear() : Number(yearText);
    if (!Number.isInteger(year) || year < 1992 || year > new Date().getUTCFullYear() + 1) return Response.json({ error: "Invalid season year" }, { status: 400 });
    if (publicRead) { await this.schedule(year, false); return this.snapshot(year); }
    if (request.method === "POST" && (url.pathname === "/refresh" || url.pathname === "/seed")) {
      // Explicit admin ingestion is synchronous: the 24-hour interval is only
      // the steady-state refresh cadence after this immediate acquisition.
      await this.schedule(year, true);
      await this.alarm();
      const snapshotResponse = await this.snapshot(year);
      const snapshot = await snapshotResponse.json() as Record<string, unknown>;
      return Response.json({
        scheduled: true,
        attempted: true,
        team_key: this.teamKey,
        year,
        snapshot,
        diagnostics: [...(await this.storage.list<TeamEndpointState<unknown>>({ prefix: ENDPOINT_PREFIX })).values()].map((state) => ({
          endpoint: state.endpoint,
          http_status: state.lastHttpStatus ?? null,
          last_error: state.lastError ?? null,
        })),
      });
    }
    if (request.method === "GET" && url.pathname === "/state") {
      const tasks = await this.storage.list<TeamPollTask>({ prefix: TASK_PREFIX });
      const states = await this.storage.list<TeamEndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      return Response.json({ team_key: this.teamKey,
        polling: [...tasks.values()].map((task) => ({ endpoint: task.endpoint, due_at: task.dueAt, interval_ms: task.intervalMs, attempts: task.attempts })),
        endpoints: [...states.values()].map((state) => ({ endpoint: state.endpoint, status: state.status, revision: state.revision, last_fetched_at: state.lastFetchedAt, last_attempt_at: state.lastAttemptAt })),
        diagnostics: [...states.values()].map((state) => ({ endpoint: state.endpoint, http_status: state.lastHttpStatus ?? null, last_error: state.lastError ?? null })) });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  private async snapshot(year: number): Promise<Response> {
    const states = await Promise.all(this.endpoints(year).map((endpoint) => this.storage.get<TeamEndpointState<unknown>>(endpointKey(endpoint))));
    const [team, districts, events, media, statboticsYear, statboticsEvents] = states, now = Date.now();
    const teamSource = metadata(team, now), districtSource = metadata(districts, now);
    const eventSource = metadata(events, now), mediaSource = metadata(media, now);
    const statboticsYearSource = metadata(statboticsYear, now), statboticsEventsSource = metadata(statboticsEvents, now);
    const snapshot = normalizeFieldViewTeamSnapshot({ team_key: this.teamKey, year,
      sources: {
        ...(teamSource ? { tba_team: teamSource } : {}),
        ...(districtSource ? { tba_team_districts: districtSource } : {}),
        ...(eventSource ? { tba_team_events: eventSource } : {}),
        ...(mediaSource ? { tba_team_media: mediaSource } : {}),
        ...(statboticsYearSource ? { statbotics_team_year: statboticsYearSource } : {}),
        ...(statboticsEventsSource ? { statbotics_team_events: statboticsEventsSource } : {}),
      },
      ...(acquired(team) ? { team: team!.data as TBATeam | null } : {}),
      ...(acquired(districts) ? { districts: districts!.data as TBADistrict[] | null } : {}),
      ...(acquired(events) ? { events: events!.data as TBAEvent[] | null } : {}),
      ...(acquired(media) ? { media: media!.data as TBAMedia[] | null } : {}),
      ...(acquired(statboticsYear) ? { statbotics: statboticsYear!.data as StatboticsTeamYear | null } : {}),
      ...(acquired(statboticsEvents) ? { statbotics_events: statboticsEvents!.data as StatboticsTeamEvent[] | null } : {}),
    });
    return Response.json(snapshot, { headers: {
      "X-FieldView-Snapshot-Version": String(await this.storage.get<number>("snapshot-revision") ?? 0),
      "Cache-Control": "no-store",
    } });
  }
  async alarm(): Promise<void> {
    if (!(await this.restoreIdentity())) return;
    const now = Date.now();
    const due = await this.storage.transaction(async (tx) => {
      const tasks = await tx.list<TeamPollTask>({ prefix: TASK_PREFIX });
      const ready = [...tasks.values()].filter((task) => task.dueAt <= now)
        .map((task) => ({ ...task, attempts: task.attempts + 1 }));
      for (const task of ready) {
        const retryAt = now + Math.min(3_600_000, 30_000 * (2 ** Math.min(task.attempts - 1, 6)));
        await tx.put(taskKey(task.endpoint), { ...task, dueAt: retryAt });
      }
      await this.rearm(tx); return ready;
    });
    for (const task of due) {
      const stored = await this.storage.get<TeamEndpointState<unknown>>(endpointKey(task.endpoint));
      const initial: TeamEndpointState<unknown> = stored ?? createEndpointState<unknown>(task.endpoint);
      const requestState = createPollRequestSnapshot(initial), headers = new Headers();
      if (requestState.ifNoneMatch) headers.set("If-None-Match", requestState.ifNoneMatch);
      let result: { status: "modified"; data: unknown; etag: string | null; expiresAt: number | null } |
        { status: "not-modified"; expiresAt: number | null } | { status: "unavailable"; httpStatus: number } |
        { status: "failed"; httpStatus?: number; error?: string };
      try {
        const isStatbotics = task.endpoint.startsWith("/team_year/") || task.endpoint.startsWith("/team_events?");
        const response = await (isStatbotics ? this.statboticsApi.request(task.endpoint, { headers }) : this.api.request(task.endpoint, { headers })), ttl = maxAge(response.headers.get("Cache-Control"));
        const expiresAt = ttl === null ? null : Date.now() + ttl * 1000;
        if (response.status === 304) result = { status: "not-modified", expiresAt: expiresAt ?? initial.expiresAt };
        else if (response.status === 404) result = { status: "unavailable", httpStatus: response.status };
        else if (!response.ok) result = { status: "failed", httpStatus: response.status };
        else result = { status: "modified", data: await response.json(), etag: response.headers.get("ETag"), expiresAt };
      } catch (error) {
        result = { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
      const changed = await this.storage.transaction(async (tx) => {
        const key = endpointKey(task.endpoint), latest = await tx.get<TeamEndpointState<unknown>>(key) ?? initial;
        const next = applyPollResponse(latest, requestState, result, Date.now(), (_current, fetched) => fetched);
        await tx.put(key, {
          ...next,
          lastHttpStatus: "httpStatus" in result ? result.httpStatus : result.status === "modified" ? 200 : latest.lastHttpStatus ?? null,
          lastError: "error" in result ? result.error : null,
        });
        if (next.revision !== latest.revision) {
          await tx.put("snapshot-revision", (await tx.get<number>("snapshot-revision") ?? 0) + 1);
        }
        return result.status === "failed";
      });
      const key = taskKey(task.endpoint), current = await this.storage.get<TeamPollTask>(key);
      if (current) {
        await this.storage.put(key, changed
          ? { ...current, dueAt: Date.now() + Math.min(3_600_000, 30_000 * (2 ** Math.min(task.attempts - 1, 6))), attempts: task.attempts }
          : { ...current, dueAt: Date.now() + task.intervalMs, attempts: 0 });
      }
    }
    await this.storage.transaction((tx) => this.rearm(tx));
  }
}
