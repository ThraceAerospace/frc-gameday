import { TBAApiClient } from "../../../packages/providers/tba/src/client.ts";
import { TBA_ENDPOINTS } from "../../../packages/providers/tba/src/endpoints.ts";
import { StatboticsApiClient } from "../../../packages/providers/statbotics/src/client.ts";
import { STATBOTICS_ENDPOINTS } from "../../../packages/providers/statbotics/src/endpoints.ts";
import { FRCColorsApiClient } from "../../../packages/providers/frc-colors/src/client.ts";
import { FRC_COLORS_ENDPOINTS } from "../../../packages/providers/frc-colors/src/endpoints.ts";
import type { StatboticsTeamEvent, StatboticsTeamYear } from "../../../packages/providers/statbotics/src/types.ts";
import type { FRCColorsTeam } from "../../../packages/providers/frc-colors/src/types.ts";
import { applyPollResponse, createEndpointState, createPollRequestSnapshot, type EndpointState } from "./endpoint-state.ts";
import type { DurableObjectStateLike, DurableObjectTransactionLike, RuntimeEnvironment } from "./cloudflare.ts";
import type { TBADistrict, TBAMedia, TBAEvent, TBATeam } from "../../../packages/providers/tba/src/types.ts";
import type { FieldViewSourceRecordMetadata } from "../../../packages/domain/src/source-metadata.ts";
import { normalizeFieldViewTeamSnapshot } from "../../../packages/domain/src/normalization/team-snapshot.ts";
import { acquireProviderRequestPermit, releaseProviderRequestPermit } from "./provider-request-gate.ts";

type TeamProvider = "tba" | "statbotics" | "frc-colors";
export interface TeamResource { provider: TeamProvider; endpoint: string; }
interface ManualTeamPollRequest { endpoint: string; year: number; dueAt: number; attempts: number; }
interface TeamPollTask extends TeamResource { dueAt: number; intervalMs: number; attempts: number; }
interface TeamEndpointState<T> extends EndpointState<T> {
  lastHttpStatus?: number | null;
  lastError?: string | null;
}
const TASK_PREFIX = "task:";
const MANUAL_QUEUE_KEY = "manual:poll-queue";
const ENDPOINT_PREFIX = "endpoint:";
const DAY_MS = 86_400_000;
const endpointKey = (endpoint: string) => ENDPOINT_PREFIX + endpoint;
const taskKey = (endpoint: string) => TASK_PREFIX + endpoint;
const validKey = (value: string) => /^[a-zA-Z0-9_-]+$/.test(value);

function staggeredProviderDueAt(endpoint: string, base: number, interval: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < endpoint.length; index += 1) {
    hash ^= endpoint.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return base + ((hash >>> 0) % Math.max(1, interval));
}

export function teamResourceEndpoints(teamKey: string, year: number): TeamResource[] {
  const providerTeamKey = /^\d+$/.test(teamKey) ? "frc" + teamKey : teamKey;
  const teamNumber = Number(providerTeamKey.replace(/^frc/i, ""));
  return [
    { provider: "tba", endpoint: TBA_ENDPOINTS.team(providerTeamKey) },
    { provider: "tba", endpoint: TBA_ENDPOINTS.teamDistricts(providerTeamKey) },
    { provider: "tba", endpoint: TBA_ENDPOINTS.teamEvents(providerTeamKey, year) },
    { provider: "tba", endpoint: TBA_ENDPOINTS.teamMedia(providerTeamKey, year) },
    { provider: "statbotics", endpoint: STATBOTICS_ENDPOINTS.teamYear(teamNumber, year) },
    { provider: "statbotics", endpoint: STATBOTICS_ENDPOINTS.teamEvents({ team: teamNumber, year }) },
    { provider: "frc-colors", endpoint: FRC_COLORS_ENDPOINTS.team(teamNumber) },
  ];
}

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
  private readonly frcColorsApi: FRCColorsApiClient;
  private readonly env: RuntimeEnvironment;
  private teamKey: string;
  constructor(state: DurableObjectStateLike, env: RuntimeEnvironment, teamKey = "") {
    this.storage = state.storage; this.env = env; this.teamKey = teamKey;
    this.api = new TBAApiClient({ apiKey: env.TBA_API_KEY, ...(env.fetcher ? { fetch: env.fetcher } : {}) });
    this.statboticsApi = new StatboticsApiClient({
      ...(env.STATBOTICS_API_BASE_URL ? { baseUrl: env.STATBOTICS_API_BASE_URL } : {}),
      ...(env.fetcher ? { fetch: env.fetcher } : {}),
    });
    this.frcColorsApi = new FRCColorsApiClient(env.fetcher ? { fetch: env.fetcher } : {});
  }
  private refreshIntervalMs(): number {
    const configured = this.env.TEAM_REFRESH_INTERVAL_MS;
    const interval = configured === undefined ? DAY_MS : Number(configured);
    if (!Number.isSafeInteger(interval) || interval < 60_000) {
      throw new Error("TEAM_REFRESH_INTERVAL_MS must be an integer of at least 60000");
    }
    return interval;
  }
  private endpoints(year: number): TeamResource[] {
    return teamResourceEndpoints(this.teamKey, year);
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
    const manual = await tx.get<ManualTeamPollRequest[]>(MANUAL_QUEUE_KEY) ?? [];
    const next = [...tasks.values()].reduce<number | null>((value, task) => value === null || task.dueAt < value ? task.dueAt : value, manual.reduce<number | null>((value, item) => value === null || item.dueAt < value ? item.dueAt : value, null));
    const current = await tx.getAlarm?.();
    if (next === null) {
      if (current !== null && current !== undefined) await tx.deleteAlarm();
    } else if (current !== next) {
      await tx.setAlarm(next);
    }
  }
  private async enqueueManualPolls(resources: TeamResource[], year: number): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const current = await tx.get<ManualTeamPollRequest[]>(MANUAL_QUEUE_KEY) ?? [];
      const existing = new Map(current.map((item) => [item.endpoint, item]));
      const ordered = new Map<string, ManualTeamPollRequest>();
      // Preserve caller priority (team event history is first during seed),
      // while retaining already queued work after the explicitly requested items.
      for (const resource of resources) {
        const previous = existing.get(resource.endpoint);
        ordered.set(resource.endpoint, {
          endpoint: resource.endpoint, year,
          dueAt: Math.min(previous?.dueAt ?? Date.now(), Date.now()),
          attempts: previous?.attempts ?? 0,
        });
      }
      for (const item of current) if (!ordered.has(item.endpoint)) ordered.set(item.endpoint, item);
      const next = [...ordered.values()];
      const unchanged = current.length === next.length && current.every((item, index) =>
        item.endpoint === next[index]?.endpoint && item.year === next[index]?.year &&
        item.dueAt === next[index]?.dueAt && item.attempts === next[index]?.attempts);
      if (!unchanged) await tx.put(MANUAL_QUEUE_KEY, next);
      await this.rearm(tx);
    });
  }
  private async schedule(year: number, immediate: boolean): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const now = Date.now();
      // Discard malformed tasks from older/incorrect resource scheduling formats.
      // In particular, provider identity must be stored alongside a string endpoint.
      const existingTasks = await tx.list<TeamPollTask>({ prefix: TASK_PREFIX });
      for (const [key, task] of existingTasks) {
        if (typeof task.endpoint !== "string" ||
          (task.provider !== "tba" && task.provider !== "statbotics" && task.provider !== "frc-colors")) {
          await tx.delete(key);
        }
      }
      const intervalMs = this.refreshIntervalMs();
      for (const resource of this.endpoints(year)) {
        const { provider, endpoint } = resource;
        const key = taskKey(endpoint), previous = await tx.get<TeamPollTask>(key);
        // Resource registration must never advance an existing recurring fetch.
        const task = {
          provider, endpoint,
          dueAt: previous?.dueAt ?? (immediate ? now + intervalMs : now),
          intervalMs, attempts: previous?.attempts ?? 0,
        } satisfies TeamPollTask;
        if (!previous || previous.provider !== task.provider || previous.endpoint !== task.endpoint ||
            previous.dueAt !== task.dueAt || previous.intervalMs !== task.intervalMs ||
            previous.attempts !== task.attempts) {
          await tx.put(key, task);
        }
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
    if (publicRead) {
      // Queue only missing/stale resources. Do not execute an alarm inline:
      // the caller receives the best current snapshot while durable work runs.
      const resources = this.endpoints(year);
      const states = await Promise.all(resources.map(({ endpoint }) =>
        this.storage.get<TeamEndpointState<unknown>>(endpointKey(endpoint))));
      const now = Date.now();
      const needed = resources.filter((resource, index) => {
        const state = states[index];
        return !state || (state.lastFetchedAt === null && state.status !== "unavailable") || state.status === "failed" || state.status === "stale" ||
          (state.expiresAt !== null && state.expiresAt <= now);
      });
      if (needed.length > 0) {
        await this.schedule(year, true);
        await this.enqueueManualPolls(needed, year);
      }
      return this.snapshot(year);
    }
    if (request.method === "POST" && (url.pathname === "/refresh" || url.pathname === "/seed")) {
      // Explicit admin ingestion queues durable work. Each alarm processes one
      // provider request; the 24-hour interval is the steady-state cadence.
      await this.schedule(year, true);
      const resources = this.endpoints(year);
      const historyEndpoint = TBA_ENDPOINTS.teamEvents(this.teamKey, year);
      // Event history is the prerequisite for event-cohort seeding, so acquire
      // it before the remaining profile and analytics resources.
      const prioritized = [
        ...resources.filter((resource) => resource.provider === "tba" && resource.endpoint === historyEndpoint),
        ...resources.filter((resource) => resource.endpoint !== historyEndpoint),
      ];
      await this.enqueueManualPolls(prioritized, year);
      await this.alarm();
      const snapshotResponse = await this.snapshot(year);
      const snapshot = await snapshotResponse.json() as Record<string, unknown>;
      const taskRegistry = await this.storage.list<TeamPollTask>({ prefix: TASK_PREFIX });
      const providerByEndpoint = new Map([...taskRegistry.values()].map((task) => [task.endpoint, task.provider]));
      return Response.json({
        scheduled: true,
        attempted: true,
        team_key: this.teamKey,
        year,
        snapshot,
        diagnostics: [...(await this.storage.list<TeamEndpointState<unknown>>({ prefix: ENDPOINT_PREFIX })).values()].map((state) => ({
          provider: providerByEndpoint.get(state.endpoint) ?? null,
          endpoint: state.endpoint,
          http_status: state.lastHttpStatus ?? null,
          last_error: state.lastError ?? null,
        })),
      });
    }
    if (request.method === "POST" && url.pathname === "/ingest-resource") {
      const body: unknown = await request.json().catch(() => null);
      const endpoint = body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).endpoint : null;
      const resource = typeof endpoint === "string" ? this.endpoints(year).find((item) => item.endpoint === endpoint) : undefined;
      if (!resource) return Response.json({ error: "Resource endpoint is not part of this team and season" }, { status: 400 });
      await this.enqueueManualPolls([resource], year);
      await this.alarm();
      const state = await this.storage.get<TeamEndpointState<unknown>>(endpointKey(resource.endpoint));
      return Response.json({ endpoint: resource.endpoint, queued: true, status: state?.status ?? "pending" }, { status: 202 });
    }
    if (request.method === "GET" && url.pathname === "/state") {
      const tasks = await this.storage.list<TeamPollTask>({ prefix: TASK_PREFIX });
      const states = await this.storage.list<TeamEndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      const providerByEndpoint = new Map([...tasks.values()].map((task) => [task.endpoint, task.provider]));
      return Response.json({ team_key: this.teamKey, snapshot_revision: await this.storage.get<number>("snapshot-revision") ?? 0,
        polling: [...tasks.values()].map((task) => ({ provider: task.provider, endpoint: task.endpoint, due_at: task.dueAt, interval_ms: task.intervalMs, attempts: task.attempts })),
        endpoints: [...states.values()].map((state) => {
          const value = state.providerData ?? state.data;
          const recordCount = Array.isArray(value) ? value.length : value == null ? 0 : 1;
          return {
            provider: providerByEndpoint.get(state.endpoint) ?? null,
            endpoint: state.endpoint, status: state.status, revision: state.revision,
            last_fetched_at: state.lastFetchedAt, last_attempt_at: state.lastAttemptAt, expires_at: state.expiresAt,
            record_count: recordCount, included_count: recordCount, excluded_count: 0,
            data_kind: Array.isArray(value) ? "array" : value === null ? "empty" : typeof value,
            http_status: state.lastHttpStatus ?? null, last_error: state.lastError ?? null,
          };
        }),
        diagnostics: [...states.values()].map((state) => ({ provider: providerByEndpoint.get(state.endpoint) ?? null, endpoint: state.endpoint, http_status: state.lastHttpStatus ?? null, last_error: state.lastError ?? null })) });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  private async snapshot(year: number): Promise<Response> {
    const states = await Promise.all(this.endpoints(year).map(({ endpoint }) => this.storage.get<TeamEndpointState<unknown>>(endpointKey(endpoint))));
    const [team, districts, events, media, statboticsYear, statboticsEvents, frcColors] = states, now = Date.now();
    const teamSource = metadata(team, now), districtSource = metadata(districts, now);
    const eventSource = metadata(events, now), mediaSource = metadata(media, now);
    const statboticsYearSource = metadata(statboticsYear, now), statboticsEventsSource = metadata(statboticsEvents, now);
    const frcColorsSource = metadata(frcColors, now);
    const snapshot = normalizeFieldViewTeamSnapshot({ team_key: this.teamKey, year,
      sources: {
        ...(teamSource ? { tba_team: teamSource } : {}),
        ...(districtSource ? { tba_team_districts: districtSource } : {}),
        ...(eventSource ? { tba_team_events: eventSource } : {}),
        ...(mediaSource ? { tba_team_media: mediaSource } : {}),
        ...(statboticsYearSource ? { statbotics_team_year: statboticsYearSource } : {}),
        ...(statboticsEventsSource ? { statbotics_team_events: statboticsEventsSource } : {}),
        ...(frcColorsSource ? { frc_colors_team: frcColorsSource } : {}),
      },
      ...(acquired(team) ? { team: team!.data as TBATeam | null } : {}),
      ...(acquired(districts) ? { districts: districts!.data as TBADistrict[] | null } : {}),
      ...(acquired(events) ? { events: events!.data as TBAEvent[] | null } : {}),
      ...(acquired(media) ? { media: media!.data as TBAMedia[] | null } : {}),
      ...(acquired(statboticsYear) ? { statbotics: statboticsYear!.data as StatboticsTeamYear | null } : {}),
      ...(acquired(statboticsEvents) ? { statbotics_events: statboticsEvents!.data as StatboticsTeamEvent[] | null } : {}),
      ...(acquired(frcColors) ? { frc_colors: frcColors!.data as FRCColorsTeam | null } : {}),
    });
    return Response.json(snapshot, { headers: {
      "X-FieldView-Snapshot-Version": String(await this.storage.get<number>("snapshot-revision") ?? 0),
      "Cache-Control": "no-store",
    } });
  }
  private async pollResourceNow(resource: TeamResource): Promise<
    { deferredUntil: number } |
    { success: boolean; status: string; revision: number; last_fetched_at: number | null; http_status: number | null; last_error: string | null }
  > {
    const permit = await acquireProviderRequestPermit(this.env, "team:" + this.teamKey, resource.endpoint);
    if (!permit.granted) return { deferredUntil: permit.retryAt };
    const stored = await this.storage.get<TeamEndpointState<unknown>>(endpointKey(resource.endpoint));
    const initial: TeamEndpointState<unknown> = stored ?? createEndpointState<unknown>(resource.endpoint);
    const requestState = createPollRequestSnapshot(initial), headers = new Headers();
    if (requestState.ifNoneMatch) headers.set("If-None-Match", requestState.ifNoneMatch);
    let result: { status: "modified"; data: unknown; etag: string | null; expiresAt: number | null } |
      { status: "not-modified"; expiresAt: number | null } | { status: "unavailable"; httpStatus: number } |
      { status: "failed"; httpStatus?: number; error?: string };
    try {
      const client = resource.provider === "tba" ? this.api
        : resource.provider === "statbotics" ? this.statboticsApi : this.frcColorsApi;
      const response = await client.request(resource.endpoint, { headers });
      const ttl = maxAge(response.headers.get("Cache-Control"));
      const expiresAt = ttl === null ? null : Date.now() + ttl * 1000;
      if (response.status === 304) result = { status: "not-modified", expiresAt: expiresAt ?? initial.expiresAt };
      else if (response.status === 404) result = { status: "unavailable", httpStatus: response.status };
      else if (!response.ok) result = { status: "failed", httpStatus: response.status };
      else result = { status: "modified", data: await response.json(), etag: response.headers.get("ETag"), expiresAt };
    } catch (error) {
      result = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    } finally {
      await releaseProviderRequestPermit(this.env, permit.leaseId);
    }
    const next = await this.storage.transaction(async (tx) => {
      const key = endpointKey(resource.endpoint), latest = await tx.get<TeamEndpointState<unknown>>(key) ?? initial;
      const value = applyPollResponse(latest, requestState, result, Date.now(), (_current, fetched) => fetched);
      const diagnostic = {
        ...value,
        lastHttpStatus: "httpStatus" in result ? result.httpStatus : result.status === "modified" ? 200 : latest.lastHttpStatus ?? null,
        lastError: "error" in result ? result.error : null,
      };
      await tx.put(key, diagnostic);
      if (value.revision !== latest.revision) await tx.put("snapshot-revision", (await tx.get<number>("snapshot-revision") ?? 0) + 1);
      return diagnostic;
    });
    return {
      success: result.status !== "failed" && result.status !== "unavailable" && next.lastFetchedAt !== null,
      status: next.status, revision: next.revision,
      last_fetched_at: next.lastFetchedAt,
      http_status: next.lastHttpStatus ?? null, last_error: next.lastError ?? null,
    };
  }

  async alarm(): Promise<void> {
    if (!(await this.restoreIdentity())) return;
    const now = Date.now();
    const due = await this.storage.transaction(async (tx) => {
      const tasks = await tx.list<TeamPollTask>({ prefix: TASK_PREFIX });
      const dueTasks: TeamPollTask[] = [];
      for (const [key, task] of tasks) {
        // Durable Object storage can outlive code revisions. Never let a task
        // written with the former resource-object shape reach endpoint state
        // handling; the next explicit refresh will schedule it correctly.
        if (typeof task.endpoint !== "string" ||
          (task.provider !== "tba" && task.provider !== "statbotics" && task.provider !== "frc-colors") ||
          !Number.isFinite(task.dueAt) || !Number.isFinite(task.intervalMs) ||
          !Number.isFinite(task.attempts)) {
          await tx.delete(key);
          continue;
        }
        if (task.dueAt <= now) dueTasks.push(task);
      }
      dueTasks.sort((left, right) => left.dueAt - right.dueAt || left.endpoint.localeCompare(right.endpoint));
      const queued = await tx.get<ManualTeamPollRequest[]>(MANUAL_QUEUE_KEY) ?? [];
      const manualDue = queued.filter((item) => item.dueAt <= now);
      const intervalValue = this.env.PROVIDER_REQUEST_INTERVAL_MS;
      const providerInterval = intervalValue === undefined ? 1_000 : Math.max(100, Number(intervalValue) || 1_000);
      const deferAt = (endpoint: string) => staggeredProviderDueAt(endpoint, now + providerInterval, providerInterval);
      const selectedManual = manualDue[0];
      const selectedTask = selectedManual ? undefined : dueTasks[0];

      // Process at most one provider request per alarm. Keep all remaining
      // durable work, but spread its next due time instead of fanning out
      // gate RPCs for every resource in the same invocation.
      for (const task of dueTasks) {
        if (selectedTask?.endpoint === task.endpoint) {
          const next = { ...task, attempts: task.attempts + 1 };
          const retryAt = now + Math.min(3_600_000, 30_000 * (2 ** Math.min(next.attempts - 1, 6)));
          await tx.put(taskKey(task.endpoint), { ...next, dueAt: retryAt });
        } else {
          await tx.put(taskKey(task.endpoint), { ...task, dueAt: deferAt(task.endpoint) });
        }
      }
      if (manualDue.length > 0) {
        await tx.put(MANUAL_QUEUE_KEY, queued.map((item) =>
          selectedManual?.endpoint === item.endpoint
            ? { ...item, dueAt: now + 60_000 }
            : item.dueAt <= now ? { ...item, dueAt: deferAt(item.endpoint) } : item));
      }
      await this.rearm(tx);
      return { ready: selectedTask ? [selectedTask] : [], manualDue: selectedManual ? [selectedManual] : [] };
    });
    for (const item of due.manualDue) {
      const resource = this.endpoints(item.year).find((candidate) => candidate.endpoint === item.endpoint);
      if (!resource) continue;
      const result = await this.pollResourceNow(resource);
      const retryableFailure = "deferredUntil" in result || result.status === "failed";
      const retryAt = "deferredUntil" in result ? result.deferredUntil
        : Date.now() + Math.min(60_000, 1_000 * (2 ** Math.min(item.attempts, 6)));
      await this.storage.transaction(async (tx) => {
        const queue = await tx.get<ManualTeamPollRequest[]>(MANUAL_QUEUE_KEY) ?? [];
        const next = queue.filter((queued) => queued.endpoint !== item.endpoint);
        if (retryableFailure && item.attempts < 8) {
          // A gate denial is scheduling, not a provider attempt.
          next.push({ ...item, dueAt: retryAt, attempts: "deferredUntil" in result ? item.attempts : item.attempts + 1 });
        }
        await tx.put(MANUAL_QUEUE_KEY, next);
        await this.rearm(tx);
      });
    }
    for (const task of due.ready) {
      const stored = await this.storage.get<TeamEndpointState<unknown>>(endpointKey(task.endpoint));
      const initial: TeamEndpointState<unknown> = stored ?? createEndpointState<unknown>(task.endpoint);
      const requestState = createPollRequestSnapshot(initial), headers = new Headers();
      if (requestState.ifNoneMatch) headers.set("If-None-Match", requestState.ifNoneMatch);
      let result: { status: "modified"; data: unknown; etag: string | null; expiresAt: number | null } |
        { status: "not-modified"; expiresAt: number | null } | { status: "unavailable"; httpStatus: number } |
        { status: "failed"; httpStatus?: number; error?: string };
      const permit = await acquireProviderRequestPermit(this.env, "team:" + this.teamKey, task.endpoint);
      if (!permit.granted) {
        const current = await this.storage.get<TeamPollTask>(taskKey(task.endpoint));
        if (current) await this.storage.put(taskKey(task.endpoint), { ...current, dueAt: permit.retryAt, attempts: task.attempts });
        continue;
      }
      try {
        const client = task.provider === "tba" ? this.api
          : task.provider === "statbotics" ? this.statboticsApi
            : task.provider === "frc-colors" ? this.frcColorsApi : null;
        if (!client) throw new Error(`Unsupported team resource provider: ${String(task.provider)}`);
        const response = await client.request(task.endpoint, { headers });
        const ttl = maxAge(response.headers.get("Cache-Control"));
        const expiresAt = ttl === null ? null : Date.now() + ttl * 1000;
        if (response.status === 304) result = { status: "not-modified", expiresAt: expiresAt ?? initial.expiresAt };
        else if (response.status === 404) result = { status: "unavailable", httpStatus: response.status };
        else if (!response.ok) result = { status: "failed", httpStatus: response.status };
        else result = { status: "modified", data: await response.json(), etag: response.headers.get("ETag"), expiresAt };
      } catch (error) {
        result = { status: "failed", error: error instanceof Error ? error.message : String(error) };
      } finally {
        await releaseProviderRequestPermit(this.env, permit.leaseId);
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
