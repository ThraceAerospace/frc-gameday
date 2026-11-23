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
import { normalizeFieldViewTeamState } from "../../../packages/domain/src/normalization/team-state.ts";
import { normalizeFieldViewTeamEventState } from "../../../packages/domain/src/normalization/team-event-state.ts";
import type { FieldViewEventState } from "../../../packages/domain/src/event.ts";
import type { FieldViewTeamEventState } from "../../../packages/domain/src/team.ts";
import type { FieldViewEventTeamSeasonComparisonInput, FieldViewAnalyticsInputRecord } from "../../../packages/domain/src/analytics.ts";
import { calculateCanonicalTeamEventAnalytics } from "../../../packages/analytics/src/canonical-match-analytics.ts";
import { buildSeasonDiagnostics } from "../../../packages/analytics/src/season-diagnostics.ts";
import type { SeasonMatchEvidence } from "../../../packages/analytics/src/season-diagnostics.ts";
import type { FieldViewTeamEventAnalytics } from "../../../packages/domain/src/analytics.ts";

type TeamProvider = "tba" | "statbotics" | "frc-colors";
interface ActiveEventMembership { year: number; updatedAt: number; }
const ACTIVE_EVENTS_KEY = "activity:active-events";
const TEAM_EVENT_STATE_PREFIX = "team-event-state:";
const TEAM_EVENT_REVISION_PREFIX = "team-event-revision:";
export interface TeamResource { provider: TeamProvider; endpoint: string; }
interface ManualTeamPollRequest { endpoint: string; year: number; dueAt: number; attempts: number; }
interface TeamPollTask extends TeamResource { dueAt: number; intervalMs: number; attempts: number; }
interface TeamEndpointState<T> extends EndpointState<T> {
  lastHttpStatus?: number | null;
  lastError?: string | null;
}
const TASK_PREFIX = "task:";
const MANUAL_QUEUE_KEY = "manual:poll-queue";
const SEASON_ANALYTICS_DUE_PREFIX = "season-analytics:due:";
const ENDPOINT_PREFIX = "endpoint:";
const DAY_MS = 86_400_000;
function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const normalize = (value: string) => value.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((candidate) =>
    candidate.trim() === "*" || normalize(candidate) === normalize(etag));
}

async function hashSignature(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const endpointKey = (endpoint: string) => ENDPOINT_PREFIX + endpoint;
const taskKey = (endpoint: string) => TASK_PREFIX + endpoint;
const validKey = (value: string) => /^[a-zA-Z0-9_-]+$/.test(value);

function isStatboticsRefreshTrigger(resource: TeamResource): boolean {
  if (resource.provider !== "tba") return false;
  const parts = resource.endpoint.split("/");
  return (parts.length === 3 && parts[1] === "team" && Boolean(parts[2])) ||
    (parts.length === 5 && parts[1] === "team" && Boolean(parts[2]) &&
      parts[3] === "events" && /^\d{4}$/.test(parts[4] ?? ""));
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
  private readonly activation: Promise<void>;
  private readonly hydrationMode: "platform-barrier" | "storage-backed";
  private readonly publishedSnapshots = new Map<number, {
    input_signature: string;
    representation_signature?: string;
    state: ReturnType<typeof normalizeFieldViewTeamState>;
  }>();
  constructor(state: DurableObjectStateLike, env: RuntimeEnvironment, teamKey = "") {
    this.storage = state.storage; this.env = env; this.teamKey = teamKey;
    this.api = new TBAApiClient({ apiKey: env.TBA_API_KEY, ...(env.fetcher ? { fetch: env.fetcher } : {}) });
    this.statboticsApi = new StatboticsApiClient({
      ...(env.STATBOTICS_API_BASE_URL ? { baseUrl: env.STATBOTICS_API_BASE_URL } : {}),
      ...(env.fetcher ? { fetch: env.fetcher } : {}),
    });
    this.frcColorsApi = new FRCColorsApiClient(env.fetcher ? { fetch: env.fetcher } : {});
    this.hydrationMode = state.blockConcurrencyWhile ? "platform-barrier" : "storage-backed";
    // Restore only this TeamRuntime's persisted identity and publications.
    // Provider refresh and cross-runtime work remain alarm-driven.
    this.activation = state.blockConcurrencyWhile
      ? state.blockConcurrencyWhile(async () => {
          const [storedKey, publications] = await Promise.all([
            this.storage.get<string>("team-key"),
            this.storage.list<{ input_signature: string; representation_signature?: string; state: ReturnType<typeof normalizeFieldViewTeamState> }>({ prefix: "team-state:" }),
          ]);
          if (storedKey && !this.teamKey) this.teamKey = storedKey;
          const publishedYears = new Set<number>();
          for (const [key, publication] of publications) {
            const match = /^team-state:(\d+):publication$/.exec(key);
            if (match && publication?.state) {
              const year = Number(match[1]);
              this.publishedSnapshots.set(year, publication);
              publishedYears.add(year);
            }
          }
          // Retire the former duplicate raw-snapshot key when its canonical
          // publication exists. A legacy-only key is retained until rebuilt.
          for (const [key] of publications) {
            const match = /^team-state:(\d+)$/.exec(key);
            if (match && publishedYears.has(Number(match[1]))) {
              await this.storage.delete(key);
            }
          }
        })
      : Promise.resolve();
  }
  private refreshIntervalMs(): number {
    const configured = this.env.TEAM_REFRESH_INTERVAL_MS;
    const interval = configured === undefined ? DAY_MS : Number(configured);
    if (!Number.isSafeInteger(interval) || interval < 60_000) {
      throw new Error("TEAM_REFRESH_INTERVAL_MS must be an integer of at least 60000");
    }
    return interval;
  }
  private activeRefreshIntervalMs(): number {
    const configured = this.env.TEAM_ACTIVE_REFRESH_INTERVAL_MS;
    const interval = configured === undefined ? 60_000 : Number(configured);
    if (!Number.isSafeInteger(interval) || interval < 10_000) {
      throw new Error("TEAM_ACTIVE_REFRESH_INTERVAL_MS must be an integer of at least 10000");
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
  private async clearRecurringStatboticsTasks(): Promise<void> {
    const existing = await this.storage.list<TeamPollTask>({ prefix: TASK_PREFIX });
    if (![...existing.values()].some((task) => task.provider === "statbotics")) return;
    await this.storage.transaction(async (tx) => {
      const tasks = await tx.list<TeamPollTask>({ prefix: TASK_PREFIX });
      for (const [key, task] of tasks) {
        if (task.provider === "statbotics") await tx.delete(key);
      }
      await this.rearm(tx);
    });
  }

  private async rearm(tx: DurableObjectTransactionLike): Promise<void> {
    const tasks = await tx.list<TeamPollTask>({ prefix: TASK_PREFIX });
    const manual = await tx.get<ManualTeamPollRequest[]>(MANUAL_QUEUE_KEY) ?? [];
    const seasonAnalytics = await tx.list<number>({ prefix: SEASON_ANALYTICS_DUE_PREFIX });
    const next = [...tasks.values()].reduce<number | null>((value, task) => value === null || task.dueAt < value ? task.dueAt : value,
      [...manual.map((item) => item.dueAt), ...seasonAnalytics.values()].reduce<number | null>(
        (value, dueAt) => value === null || dueAt < value ? dueAt : value, null,
      ));
    const current = await tx.getAlarm?.();
    if (next === null) {
      if (current !== null && current !== undefined) await tx.deleteAlarm();
    } else if (current !== next) {
      await tx.setAlarm(next);
    }
  }
  private async enqueueManualPolls(resources: TeamResource[], year: number, immediate = true, scheduledAt?: number): Promise<void> {
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
          // Read-driven refreshes coalesce behind an existing retry deadline.
          // A newly queued resource is still eligible immediately.
          dueAt: scheduledAt !== undefined ? Math.min(previous?.dueAt ?? scheduledAt, scheduledAt)
            : immediate ? Math.min(previous?.dueAt ?? Date.now(), Date.now()) : previous?.dueAt ?? Date.now(),
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
    const activeEvents = await this.storage.get<Record<string, ActiveEventMembership>>(ACTIVE_EVENTS_KEY) ?? {};
    const intervalMs = Object.keys(activeEvents).length > 0 ? this.activeRefreshIntervalMs() : this.refreshIntervalMs();
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
      for (const resource of this.endpoints(year).filter((item) => item.provider !== "statbotics")) {
        const { provider, endpoint } = resource;
        const key = taskKey(endpoint), previous = await tx.get<TeamPollTask>(key);
        // Resource registration must never advance an existing recurring fetch.
        const task = {
          provider, endpoint,
          dueAt: previous ? Math.min(previous.dueAt, immediate ? now + intervalMs : now) : (immediate ? now + intervalMs : now),
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
    await this.activation;
    const url = new URL(request.url);
    const admin = Boolean(this.env.RUNTIME_ADMIN_TOKEN) && request.headers.get("Authorization") === "Bearer " + this.env.RUNTIME_ADMIN_TOKEN;
    const publicRead = request.method === "GET" && url.pathname === "/snapshot";
    const publicEventStateRead = request.method === "GET" && url.pathname === "/event-state";
    const publicSeasonAnalyticsRead = request.method === "GET" && url.pathname === "/season-analytics";
    if (!admin && !publicRead && !publicEventStateRead && !publicSeasonAnalyticsRead) return Response.json({ error: "Unauthorized" }, { status: 401 });
    // Public reads must not bind identity or perform migration cleanup writes.
    // Entity identity is established by scheduler/admin initialization before a
    // runtime is exposed to public readers.
    if (publicRead || publicSeasonAnalyticsRead || publicEventStateRead) {
      if (!(await this.restoreIdentity())) {
        return Response.json({ error: "Team state is not ready" }, {
          status: 404, headers: { "Cache-Control": "no-store" },
        });
      }
      if (request.headers.get("X-FieldView-Team-Key") !== this.teamKey) {
        return Response.json({ error: "Invalid or mismatched team identity" }, { status: 400 });
      }
    } else {
      if (!(await this.bindTeamKey(request))) return Response.json({ error: "Invalid or mismatched team identity" }, { status: 400 });
      // Retire legacy recurring Statbotics tasks only on an explicit/admin touch,
      // never as a side effect of a public read.
      await this.clearRecurringStatboticsTasks();
    }
    if (request.method === "POST" && url.pathname === "/webhook") {
      const eventKey = request.headers.get("X-FieldView-Event-Key") ?? "";
      const webhookId = request.headers.get("X-FieldView-Webhook-Id") ?? "";
      if (!/^[0-9]{4}[a-zA-Z0-9_-]+$/.test(eventKey) || !/^[a-f0-9]{64}$/.test(webhookId)) {
        return Response.json({ error: "Invalid webhook identity" }, { status: 400 });
      }
      const rawPayload = await request.text();
      let payload: unknown;
      try { payload = JSON.parse(rawPayload); }
      catch { return Response.json({ error: "Invalid webhook JSON" }, { status: 400 }); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return Response.json({ error: "Invalid TBA webhook payload" }, { status: 400 });
      }
      const envelope = payload as Record<string, unknown>;
      const messageData = envelope.message_data;
      if (typeof envelope.message_type !== "string" || !messageData || typeof messageData !== "object" || Array.isArray(messageData)) {
        return Response.json({ error: "Invalid TBA webhook payload" }, { status: 400 });
      }
      const data = messageData as Record<string, unknown>;
      const targetKeys = new Set<string>();
      const match = data.match;
      if ((envelope.message_type === "match_score" || envelope.message_type === "match_video") &&
          match && typeof match === "object" && !Array.isArray(match)) {
        if (typeof data.team_key === "string") targetKeys.add(data.team_key);
        const value = match as Record<string, unknown>;
        const alliances = value.alliances;
        if (alliances && typeof alliances === "object" && !Array.isArray(alliances)) {
          for (const color of ["red", "blue"]) {
            const alliance = (alliances as Record<string, unknown>)[color];
            if (alliance && typeof alliance === "object" && !Array.isArray(alliance)) {
              const value = alliance as Record<string, unknown>;
              const keys = Array.isArray(value.teams) ? value.teams : value.team_keys;
              if (Array.isArray(keys)) for (const key of keys) if (typeof key === "string") targetKeys.add(key);
            }
          }
        }
      } else {
        if (Array.isArray(data.team_keys)) for (const key of data.team_keys) if (typeof key === "string") targetKeys.add(key);
        if (typeof data.team_key === "string") targetKeys.add(data.team_key);
      }
      if (!targetKeys.has(this.teamKey)) return Response.json({ accepted: true, affected: false });
      const storageKey = TEAM_EVENT_STATE_PREFIX + eventKey;
      const revisionKey = TEAM_EVENT_REVISION_PREFIX + eventKey;
      const existing = await this.storage.get<FieldViewTeamEventState>(storageKey);
      if (!existing) return Response.json({ accepted: true, affected: true, projection: "not-yet-materialized" });
      // EventRuntime owns canonical match records and match webhooks. TeamRuntime
      // stores only references to those records, so event match notifications
      // do not mutate a copied match projection here. EventRuntime's own webhook
      // reconciliation invalidates event analytics and later requests fresh
      // TeamEventState from each participant owner.
      const matchKey = typeof data.match_key === "string" ? data.match_key
        : match && typeof match === "object" && !Array.isArray(match) &&
            typeof (match as Record<string, unknown>).key === "string"
          ? (match as Record<string, unknown>).key as string : null;
      const knownMatch = matchKey !== null &&
        (existing.match_refs ?? []).some((reference) => reference.record_id === matchKey);
      return Response.json({
        accepted: true,
        affected: true,
        changed: false,
        canonical_owner: "event-runtime",
        projection: knownMatch ? "foreign-reference-unchanged" : "match-not-yet-referenced",
        revision: await this.storage.get<number>(revisionKey) ?? 0,
      });
    }

    const yearText = url.searchParams.get("year") ?? (url.pathname === "/event-state" ? url.searchParams.get("event_key")?.slice(0, 4) ?? null : null);
    const year = yearText === null ? new Date().getUTCFullYear() : Number(yearText);
    if (!Number.isInteger(year) || year < 1992 || year > new Date().getUTCFullYear() + 1) return Response.json({ error: "Invalid season year" }, { status: 400 });

    if (publicSeasonAnalyticsRead) {
      const teamPublication = await this.storage.get<{ input_signature?: string; state?: unknown }>("team-state:" + year + ":publication");
      const teamState = teamPublication?.state;
      if (!teamPublication || typeof teamPublication.input_signature !== "string" || !teamState || typeof teamState !== "object" || Array.isArray(teamState) ||
          (teamState as Record<string, unknown>).team_key !== this.teamKey ||
          (teamState as Record<string, unknown>).year !== year ||
          !(teamState as Record<string, unknown>).sources ||
          typeof (teamState as Record<string, unknown>).sources !== "object" ||
          Array.isArray((teamState as Record<string, unknown>).sources)) {
        return Response.json({ error: "Team state is not ready", team_key: this.teamKey, year }, {
          status: 404, headers: { "Cache-Control": "no-store" },
        });
      }
      const cacheKey = "team-season-analytics:" + year;
      const cached = await this.storage.get<{
        team_source_revision: number;
        event_revisions: Record<string, number>;
        event_source_revisions: Record<string, number | null>;
        comparison_input_updated_ats: Record<string, number | null>;
        checkedAt?: number;
        response: Record<string, unknown>;
      }>(cacheKey);
      const currentTeamRevision = await this.storage.get<number>("snapshot-revision") ?? 0;
      const currentEventRevisions = cached
        ? Object.fromEntries(await Promise.all(Object.keys(cached.event_revisions).map(async (eventKey) => [
            eventKey, await this.storage.get<number>(TEAM_EVENT_REVISION_PREFIX + eventKey) ?? 0,
          ] as const)))
        : {};
      const revisionStale = !cached || cached.team_source_revision !== currentTeamRevision ||
        JSON.stringify(cached.event_revisions) !== JSON.stringify(currentEventRevisions);
      const checkedAt = cached?.checkedAt ?? Number(
        (cached?.response.collection as Record<string, unknown> | undefined)?.updatedAt ?? 0,
      );
      const freshnessStale = !checkedAt || Date.now() - checkedAt > 5 * 60_000;
      const collectionState = (cached?.response.collection as Record<string, unknown> | undefined)?.state;
      const partial = Boolean(cached) && collectionState !== "complete";
      const stale = revisionStale || freshnessStale;
      if (stale || partial) await this.queueSeasonAnalyticsRefresh(year);

      const resources = this.endpoints(year);
      const states = await Promise.all(resources.map(({ endpoint }) =>
        this.storage.get<TeamEndpointState<unknown>>(endpointKey(endpoint))));
      const now = Date.now();
      const needed = resources.filter((resource, index) => {
        if (resource.provider === "statbotics") return false;
        const state = states[index];
        return !state || (state.lastFetchedAt === null && state.status !== "unavailable") ||
          state.status === "failed" || state.status === "stale" ||
          (state.expiresAt !== null && state.expiresAt <= now);
      });
      if (needed.length > 0) {
        await this.schedule(year, true);
        await this.enqueueManualPolls(needed, year, false);
      }
      if (!cached) {
        return Response.json({
          team_key: this.teamKey, year, status: "unavailable",
          publication: { status: "missing" }, revalidation: "scheduled",
        }, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } });
      }
      return Response.json(cached.response, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
          "X-FieldView-Analytics-Status": stale ? "stale" : partial ? "partial" : "complete",
          "X-FieldView-Analytics-Revalidation": stale || partial ? "scheduled" : "idle",
          "X-FieldView-Analytics-Checked-At": String(checkedAt),
        },
      });
    }

    if (publicRead) {
      // Serve the last atomically published representation. A GET never
      // rebuilds/persists a snapshot and never materializes another season.
      const stateKey = `team-state:${year}`;
      const publication = this.publishedSnapshots.get(year) ??
        await this.storage.get<{
          input_signature: string;
          representation_signature?: string;
          state: ReturnType<typeof normalizeFieldViewTeamState>;
        }>(stateKey + ":publication");
      const publishedState = publication?.state as Record<string, unknown> | undefined;
      if (!publication || typeof publication.input_signature !== "string" || !publishedState || publishedState.team_key !== this.teamKey || publishedState.year !== year ||
          !publishedState.sources || typeof publishedState.sources !== "object" || Array.isArray(publishedState.sources)) {
        return Response.json({ error: "Team state is not ready", team_key: this.teamKey, year }, {
          status: 404, headers: { "Cache-Control": "no-store" },
        });
      }
      const resources = this.endpoints(year);
      const states = await Promise.all(resources.map(({ endpoint }) =>
        this.storage.get<TeamEndpointState<unknown>>(endpointKey(endpoint))));
      const now = Date.now();
      const signature = JSON.stringify(states.map((state) => state ? [
        state.revision, state.status, state.lastFetchedAt, state.expiresAt,
        state.etag, state.expiresAt !== null && state.expiresAt < now,
      ] : null));
      const stale = publication.input_signature !== signature;
      const etag = 'W/"fv-team-snapshot-v1-' + year + '-' +
        (await this.storage.get<number>("snapshot-revision") ?? 0) + '-' +
        await hashSignature(publication.input_signature) + '"';
      const headers = {
        "X-FieldView-Snapshot-Version": String(await this.storage.get<number>("snapshot-revision") ?? 0),
        "X-FieldView-Publication-Status": stale ? "stale" : "available",
        "X-FieldView-Revalidation": "idle",
        ETag: etag,
        "Cache-Control": "private, no-cache",
      };
      if (etagMatches(request.headers.get("If-None-Match"), etag)) {
        return new Response(null, { status: 304, headers });
      }
      return Response.json(publication.state, { headers });
    }

    // Internal/admin operations may materialize the requested season. Public
    // reads above are deliberately isolated from this write-capable path.
    // Every TeamRuntime starts with the current season state, even when first
    // reached through an older event. The requested season is also materialized.
    const currentYear = new Date().getUTCFullYear();
    const initializedCurrentState = publicEventStateRead
      ? null
      : await this.storage.get<unknown>("team-state:" + currentYear + ":publication")
        ? null
        : await this.snapshot(currentYear);
    const initializedState = publicEventStateRead
      ? null
      : year === currentYear && initializedCurrentState
        ? initializedCurrentState
        : await this.snapshot(year);
    if (publicRead && initializedState?.status === 304) return initializedState;
    if (publicRead && initializedState) return initializedState;
    if (publicSeasonAnalyticsRead) {
      return this.buildSeasonAnalyticsResponse(year);
    }
    if (publicEventStateRead) {
      const eventKey = url.searchParams.get("event_key") ?? "";
      if (!/^[0-9]{4}[a-zA-Z0-9_-]+$/.test(eventKey)) return Response.json({ error: "Invalid event key" }, { status: 400 });
      const stateKey = TEAM_EVENT_STATE_PREFIX + eventKey;
      const storedState = await this.storage.get<FieldViewTeamEventState & {
        team?: import("../../../packages/domain/src/team.ts").FieldViewTeam | null;
        event_team?: import("../../../packages/domain/src/event.ts").FieldViewEventTeam | null;
        matches?: import("../../../packages/domain/src/match.ts").FieldViewMatch[] | null;
      }>(stateKey);
      if (!storedState) return Response.json({ error: "Team event state is not yet available" }, { status: 404 });
      const inputs = await this.storage.get<{ event_source_revision: number; team_source_revision: number; comparison_input_updated_at: number }>(stateKey + ":inputs");
      // Lazy, owner-local migration of old records that embedded foreign
      // EventRuntime data. This preserves the logical revision while replacing
      // copied event/team/match records with stable references.
      const hasLegacyEmbeddedRecords = "team" in storedState || "event_team" in storedState || "matches" in storedState;
      const state = hasLegacyEmbeddedRecords ? normalizeFieldViewTeamEventState({
        event_key: eventKey as FieldViewTeamEventState["event_key"],
        team_key: this.teamKey as FieldViewTeamEventState["team_key"],
        sources: storedState.sources,
        ...(storedState.team === undefined ? {} : { team: storedState.team }),
        ...(storedState.event_team === undefined ? {} : { event_team: storedState.event_team }),
        ...(storedState.matches === undefined ? {} : { matches: storedState.matches }),
        ...(storedState.analytics === undefined ? {} : { analytics: storedState.analytics }),
        event_source_revision: inputs?.event_source_revision ?? null,
      }) : storedState;
      if (hasLegacyEmbeddedRecords && JSON.stringify(state) !== JSON.stringify(storedState)) {
        await this.storage.put(stateKey, state);
      }
      return Response.json(state, {
        headers: {
          "X-FieldView-Team-Event-Revision": String(await this.storage.get<number>(TEAM_EVENT_REVISION_PREFIX + eventKey) ?? 0),
          ...(inputs ? {
            "X-FieldView-Event-Source-Revision": String(inputs.event_source_revision),
            "X-FieldView-Team-Source-Revision": String(inputs.team_source_revision),
            "X-FieldView-Comparison-Input-Updated-At": String(inputs.comparison_input_updated_at),
          } : {}),
          "Cache-Control": "no-store",
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/event-analytics") {
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Expected event analytics input" }, { status: 400 });
      const input = body as Record<string, unknown>;
      const eventKey = input.event_key;
      const eventState = input.event_state as FieldViewEventState | undefined;
      const comparisonInput = input.comparison_input as FieldViewEventTeamSeasonComparisonInput | undefined;
      const eventSourceRevision = input.event_source_revision;
      if (typeof eventKey !== "string" || !/^[0-9]{4}[a-zA-Z0-9_-]+$/.test(eventKey) ||
          !eventState || eventState.event_key !== eventKey ||
          !comparisonInput || !Array.isArray(comparisonInput.records) ||
          !Number.isSafeInteger(eventSourceRevision) || (eventSourceRevision as number) < 0) {
        return Response.json({ error: "Invalid team event analytics input" }, { status: 400 });
      }
      const year = Number(eventKey.slice(0, 4));
      const teamStateResponse = await this.snapshot(year);
      const teamState = await teamStateResponse.json() as ReturnType<typeof normalizeFieldViewTeamState>;
      const eventTeam = eventState.event_teams === undefined ? undefined
        : eventState.event_teams === null ? null
          : eventState.event_teams.find((item) => item.team_key === this.teamKey) ?? null;
      if (!eventState.teams?.some((item) => item.key === this.teamKey)) {
        return Response.json({ error: "Team is not in the supplied event roster" }, { status: 409 });
      }
      const teamMatches = eventState.matches === undefined ? undefined
        : eventState.matches === null ? null
          : eventState.matches.filter((match) =>
              match.alliances.red.team_keys.includes(this.teamKey) ||
              match.alliances.blue.team_keys.includes(this.teamKey),
            );
      const teamEventState = normalizeFieldViewTeamEventState({
        event_key: eventKey as FieldViewTeamEventState["event_key"],
        team_key: this.teamKey as FieldViewTeamEventState["team_key"],
        sources: {
          team: teamState.sources,
          event_team: eventState.sources.event_teams,
          matches: eventState.sources.matches,
        },
        ...(teamState.team === undefined ? {} : { team: teamState.team }),
        ...(eventTeam === undefined ? {} : { event_team: eventTeam }),
        ...(teamMatches === undefined ? {} : { matches: teamMatches }),
        event_source_revision: eventSourceRevision as number,
      });
      const teamSourceRevision = await this.storage.get<number>("snapshot-revision") ?? 0;
      const suppliedTeamRevision = comparisonInput.team_state_revisions?.find((item) => item.team_key === this.teamKey)?.revision;
      if (suppliedTeamRevision !== null && suppliedTeamRevision !== undefined && suppliedTeamRevision !== teamSourceRevision) {
        return Response.json({ error: "Comparison input contains a stale TeamState revision" }, { status: 409 });
      }
      const analyticsInputs: FieldViewAnalyticsInputRecord[] = [{
        input_key: "team:" + this.teamKey + ":season-state",
        provider: "fieldview",
        resource: "team-state",
        source_revision: teamSourceRevision,
        fetched_at: Date.now(),
        record_count: teamState.events?.length ?? 0,
        included_count: teamState.statbotics_events?.length ?? 0,
        excluded_count: Math.max(0, (teamState.events?.length ?? 0) - (teamState.statbotics_events?.length ?? 0)),
        status: teamState.events === undefined || teamState.statbotics_events === undefined ? "partial" : "available",
      }, {
        input_key: "event:" + eventKey + ":event-state",
        provider: "fieldview",
        resource: "event-state",
        source_revision: eventSourceRevision as number,
        fetched_at: Date.now(),
        record_count: eventState.matches?.length ?? 0,
        included_count: teamMatches?.length ?? 0,
        excluded_count: Math.max(0, (eventState.matches?.length ?? 0) - (teamMatches?.length ?? 0)),
        status: eventState.matches === undefined ? "partial" : eventState.matches === null ? "unavailable" : "available",
      }, {
        input_key: "event:" + eventKey + ":comparison-input",
        provider: "fieldview",
        resource: "event-team-season-comparison-input",
        source_revision: JSON.stringify(comparisonInput.team_state_revisions ?? []),
        fetched_at: comparisonInput.updated_at,
        record_count: comparisonInput.total_team_event_records,
        included_count: comparisonInput.processed_team_event_records - comparisonInput.unavailable_team_event_records,
        excluded_count: comparisonInput.unavailable_team_event_records,
        status: comparisonInput.state === "complete" ? "available" : "partial",
      }];
      const calculated = await calculateCanonicalTeamEventAnalytics(
        eventState,
        teamEventState,
        analyticsInputs,
        comparisonInput,
      );
      const result = calculated ?? teamEventState;
      const stateKey = TEAM_EVENT_STATE_PREFIX + eventKey;
      const revisionKey = TEAM_EVENT_REVISION_PREFIX + eventKey;
      const priorInputs = await this.storage.get<{ event_source_revision: number; team_source_revision: number; comparison_input_updated_at: number }>(stateKey + ":inputs");
      if (priorInputs && ((eventSourceRevision as number) < priorInputs.event_source_revision ||
          teamSourceRevision < priorInputs.team_source_revision || comparisonInput.updated_at < priorInputs.comparison_input_updated_at)) {
        return Response.json({ error: "Stale event analytics input" }, { status: 409 });
      }
      if ((await this.storage.get<number>("snapshot-revision") ?? 0) !== teamSourceRevision) {
        return Response.json({ error: "Team season state changed during calculation" }, { status: 409 });
      }
      const prior = await this.storage.get<FieldViewTeamEventState>(stateKey);
      if (prior && JSON.stringify(prior) === JSON.stringify(result)) {
        const revision = await this.storage.get<number>(revisionKey) ?? 0;
        return Response.json(result, { headers: {
          "X-FieldView-Team-Key": this.teamKey,
          "X-FieldView-Event-Key": eventKey,
          "X-FieldView-Team-Event-Changed": "false",
          "X-FieldView-Team-Event-Revision": String(revision),
          "X-FieldView-Event-Source-Revision": String(eventSourceRevision),
          "X-FieldView-Team-Source-Revision": String(teamSourceRevision),
          "X-FieldView-Comparison-Input-Updated-At": String(comparisonInput.updated_at),
          "Cache-Control": "no-store",
        } });
      }
      const revision = await this.storage.transaction(async (tx) => {
        const next = (await tx.get<number>(revisionKey) ?? 0) + 1;
        await tx.put(stateKey, result);
        await tx.put(revisionKey, next);
        await tx.put(stateKey + ":inputs", {
          event_source_revision: eventSourceRevision,
          team_source_revision: teamSourceRevision,
          comparison_input_updated_at: comparisonInput.updated_at,
          calculated_at: Date.now(),
        });
        return next;
      });
      return Response.json(result, { headers: {
        "X-FieldView-Team-Key": this.teamKey,
        "X-FieldView-Event-Key": eventKey,
        "X-FieldView-Team-Event-Changed": "true",
        "X-FieldView-Team-Event-Revision": String(revision),
        "X-FieldView-Event-Source-Revision": String(eventSourceRevision),
        "X-FieldView-Team-Source-Revision": String(teamSourceRevision),
        "X-FieldView-Comparison-Input-Updated-At": String(comparisonInput.updated_at),
        "Cache-Control": "no-store",
      } });
    }
    if (request.method === "POST" && url.pathname === "/activity") {
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Expected event activity payload" }, { status: 400 });
      const value = body as Record<string, unknown>;
      const eventKey = value.event_key, eventYear = value.year;
      if (typeof eventKey !== "string" || !/^[0-9]{4}[a-zA-Z0-9_-]+$/.test(eventKey) ||
          !Number.isInteger(eventYear) || (eventYear as number) < 1992 || (eventYear as number) > 2200 ||
          typeof value.active !== "boolean") {
        return Response.json({ error: "Invalid event activity payload" }, { status: 400 });
      }
      let changed = false;
      const activeEvents = await this.storage.transaction(async (tx) => {
        const current = await tx.get<Record<string, ActiveEventMembership>>(ACTIVE_EVENTS_KEY) ?? {};
        const previous = current[eventKey];
        if (value.active) {
          if (!previous || previous.year !== eventYear) {
            current[eventKey] = { year: eventYear as number, updatedAt: Date.now() };
            changed = true;
          }
        } else if (previous) {
          delete current[eventKey];
          changed = true;
        }
        if (changed) await tx.put(ACTIVE_EVENTS_KEY, current);
        return current;
      });
      const years = new Set<number>([eventYear as number, ...Object.values(activeEvents).map((item) => item.year)]);
      const expectedInterval = Object.keys(activeEvents).length > 0 ? this.activeRefreshIntervalMs() : this.refreshIntervalMs();
      const tasks = await this.storage.list<TeamPollTask>({ prefix: TASK_PREFIX });
      const scheduleMissingOrOutdated = [...years].some((activeYear) =>
        this.endpoints(activeYear).filter((resource) => resource.provider !== "statbotics").some((resource) => {
          const task = tasks.get(taskKey(resource.endpoint));
          return !task || task.intervalMs !== expectedInterval;
        }),
      );
      if (changed || scheduleMissingOrOutdated) {
        await Promise.all([...years].map((activeYear) => this.schedule(activeYear, false)));
      }
      return Response.json({ team_key: this.teamKey, active_events: Object.keys(activeEvents).sort(), active: value.active, changed });
    }
    if (request.method === "POST" && (url.pathname === "/refresh" || url.pathname === "/seed")) {
      // Explicit admin ingestion queues durable work. Independent provider
      // resources may be fetched concurrently; the 24-hour interval is the steady-state cadence.
      await this.schedule(year, true);
      const resources = this.endpoints(year);
      const historyEndpoint = TBA_ENDPOINTS.teamEvents(this.teamKey, year);
      // Event history is the prerequisite for event season-comparison input acquisition, so acquire
      // it before the remaining profile and analytics resources.
      const prioritized = [
        ...resources.filter((resource) => resource.provider === "tba" && resource.endpoint === historyEndpoint),
        ...resources.filter((resource) => resource.endpoint !== historyEndpoint),
      ];
      await this.enqueueManualPolls(prioritized, year);
      // Both refresh and seed only enqueue durable work. TeamRuntime's alarm
      // owns provider I/O; cross-runtime orchestration must never wait for it.
      const snapshotResponse = await this.snapshot(year);
      const snapshot = await snapshotResponse.json() as Record<string, unknown>;
      const taskRegistry = await this.storage.list<TeamPollTask>({ prefix: TASK_PREFIX });
      const providerByEndpoint = new Map([...taskRegistry.values()].map((task) => [task.endpoint, task.provider]));
      return Response.json({
        scheduled: true,
        queued: true,
        attempted: false,
        team_key: this.teamKey,
        year,
        snapshot,
        diagnostics: [...(await this.storage.list<TeamEndpointState<unknown>>({ prefix: ENDPOINT_PREFIX })).values()].map((state) => ({
          provider: providerByEndpoint.get(state.endpoint) ?? null,
          endpoint: state.endpoint,
          http_status: state.lastHttpStatus ?? null,
          last_error: state.lastError ?? null,
        })),
      }, { status: 202 });
    }
    if (request.method === "POST" && url.pathname === "/readiness") {
      const body: unknown = await request.json().catch(() => null);
      const requestedAt = body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).refreshAt : undefined;
      if (typeof requestedAt !== "number" || !Number.isSafeInteger(requestedAt) ||
          requestedAt < Date.now() || requestedAt > Date.now() + 5 * 60_000) {
        return Response.json({ error: "refreshAt must be within the next five minutes" }, { status: 400 });
      }
      const publication = await this.storage.get<{ input_signature?: string; state?: unknown }>("team-state:" + year + ":publication");
      const publishedState = publication?.state;
      const validState = Boolean(publication && typeof publication.input_signature === "string" && publishedState && typeof publishedState === "object" &&
        !Array.isArray(publishedState) &&
        (publishedState as Record<string, unknown>).team_key === this.teamKey &&
        (publishedState as Record<string, unknown>).year === year &&
        (publishedState as Record<string, unknown>).sources &&
        typeof (publishedState as Record<string, unknown>).sources === "object" &&
        !Array.isArray((publishedState as Record<string, unknown>).sources));
      const resources = this.endpoints(year);
      const states = await this.storage.list<TeamEndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      const now = Date.now();
      const staleResources = resources.filter((resource) => {
        const source = states.get(endpointKey(resource.endpoint));
        return !source || source.status === "failed" || source.status === "stale" ||
          (source.lastFetchedAt === null && source.status !== "unavailable") ||
          (source.expiresAt !== null && source.expiresAt <= now);
      }).map((resource) => resource.endpoint);
      const refreshQueued = !validState || staleResources.length > 0;
      let refreshAt: number | null = null;
      if (refreshQueued) {
        refreshAt = Math.max(now + 1_000, requestedAt);
        // Queue the complete team resource set behind one randomized deadline.
        // Existing recurring schedules, if any, are left untouched.
        await this.enqueueManualPolls(resources, year, true, refreshAt);
      }
      return Response.json({
        team_key: this.teamKey,
        year,
        state_valid: validState,
        stale_resources: staleResources,
        refresh_queued: refreshQueued,
        refresh_at: refreshQueued ? refreshAt : null,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method === "POST" && url.pathname === "/ingest-resource") {
      const body: unknown = await request.json().catch(() => null);
      const endpoint = body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).endpoint : null;
      const resource = typeof endpoint === "string" ? this.endpoints(year).find((item) => item.endpoint === endpoint) : undefined;
      if (!resource) return Response.json({ error: "Resource endpoint is not part of this team and season" }, { status: 400 });
      await this.enqueueManualPolls([resource], year);
      const state = await this.storage.get<TeamEndpointState<unknown>>(endpointKey(resource.endpoint));
      return Response.json({ endpoint: resource.endpoint, queued: true, status: state?.status ?? "pending" }, { status: 202 });
    }
    if (request.method === "GET" && url.pathname === "/state") {
      const tasks = await this.storage.list<TeamPollTask>({ prefix: TASK_PREFIX });
      const states = await this.storage.list<TeamEndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      const manualQueue = await this.storage.get<ManualTeamPollRequest[]>(MANUAL_QUEUE_KEY) ?? [];
      const providerByEndpoint = new Map([...tasks.values()].map((task) => [task.endpoint, task.provider]));
      const snapshotRevision = await this.storage.get<number>("snapshot-revision") ?? 0;
      return Response.json({ team_key: this.teamKey, snapshot_revision: snapshotRevision,
        readiness: {
          hydration: this.hydrationMode === "platform-barrier" ? "complete" : "storage-backed",
          hydrated_scope: ["team_identity", "team_state_publications"],
          publications: [...this.publishedSnapshots.entries()].map(([year, publication]) => ({
            year, exists: true, input_signature: publication.input_signature,
            snapshot_revision: snapshotRevision,
          })),
          pending_revalidation: {
            recurring_tasks: tasks.size,
            manual_requests: manualQueue.length,
            next_due_at: [...tasks.values()].reduce<number | null>((earliest, task) =>
              earliest === null || task.dueAt < earliest ? task.dueAt : earliest, null),
          },
          last_error: [...states.values()].find((state) => state.lastError)?.lastError ?? null,
        },
        active_events: Object.keys(await this.storage.get<Record<string, ActiveEventMembership>>(ACTIVE_EVENTS_KEY) ?? {}).sort(),
        polling: [...tasks.values()].map((task) => ({ provider: task.provider, endpoint: task.endpoint, due_at: task.dueAt, interval_ms: task.intervalMs, attempts: task.attempts })),
        resources: this.endpoints(year).map((resource) => {
          const state = [...states.values()].find((item) => item.endpoint === resource.endpoint);
          return {
            provider: resource.provider, endpoint: resource.endpoint, status: state?.status ?? "pending",
            last_fetched_at: state?.lastFetchedAt ?? null, expires_at: state?.expiresAt ?? null,
          };
        }),
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
  private async queueSeasonAnalyticsRefresh(year: number): Promise<void> {
    const key = SEASON_ANALYTICS_DUE_PREFIX + year;
    const existing = await this.storage.get<number>(key);
    const dueAt = existing ?? Date.now();
    if (existing === undefined) await this.storage.put(key, dueAt);
    // Do not move an existing retry deadline forward on every stale read.
    if (existing === undefined || existing <= Date.now()) {
      const currentAlarm = await this.storage.getAlarm?.();
      if (currentAlarm === null || currentAlarm === undefined || currentAlarm > Date.now() + 100) {
        await this.storage.setAlarm(Date.now() + 100);
      }
    }
  }

  private async buildSeasonAnalyticsResponse(year: number): Promise<Response> {
    const teamState = await this.snapshot(year).then((response) => response.json()) as ReturnType<typeof normalizeFieldViewTeamState>;
    if (teamState.events === undefined || teamState.events === null) {
      return Response.json({ error: "Team season event list is still being acquired" }, { status: 503 });
    }
    const events = teamState.events
      .filter((event) => event.event_type !== 99 && event.event_type !== 100)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
    const teamSourceRevision = await this.storage.get<number>("snapshot-revision") ?? 0;
    const eventRevisions = Object.fromEntries(await Promise.all(events.map(async (event) => [
      event.key,
      await this.storage.get<number>(TEAM_EVENT_REVISION_PREFIX + event.key) ?? 0,
    ] as const)));
    const eventAnalyticsInputs = Object.fromEntries(await Promise.all(events.map(async (event) => {
      if (!this.env.EVENT_RUNTIME || !this.env.RUNTIME_ADMIN_TOKEN) {
        return [event.key, { source_revision: null, comparison_input_updated_at: null }] as const;
      }
      try {
        const stub = this.env.EVENT_RUNTIME.get(this.env.EVENT_RUNTIME.idFromName(event.key));
        const response = await stub.fetch(new Request("https://event-runtime/analytics-state", {
          headers: {
            Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
            "X-FieldView-Event-Key": event.key,
          },
        }));
        if (!response.ok) return [event.key, { source_revision: null, comparison_input_updated_at: null }] as const;
        const state = await response.json() as {
          source_revision?: number;
          comparison_input_updated_at?: number | null;
          analytics?: { source_revision?: number | null; status?: string };
        };
        const analyticsRevision = state.analytics?.source_revision ?? null;
        const analyticsStatus = state.analytics?.status;
        const current = analyticsRevision !== null && analyticsRevision === state.source_revision &&
          analyticsStatus !== "stale" && analyticsStatus !== "failed" && analyticsStatus !== "pending";
        return [event.key, {
          source_revision: current ? analyticsRevision : null,
          comparison_input_updated_at: state.comparison_input_updated_at ?? null,
        }] as const;
      } catch {
        return [event.key, { source_revision: null, comparison_input_updated_at: null }] as const;
      }
    })));
    const eventSourceRevisions = Object.fromEntries(Object.entries(eventAnalyticsInputs).map(([key, value]) => [key, value.source_revision]));
    const comparisonInputUpdatedAts = Object.fromEntries(Object.entries(eventAnalyticsInputs).map(([key, value]) => [key, value.comparison_input_updated_at]));
    const cacheKey = "team-season-analytics:" + year;
    const cached = await this.storage.get<{
      team_source_revision: number;
      event_revisions: Record<string, number>;
      event_source_revisions: Record<string, number | null>;
      comparison_input_updated_ats: Record<string, number | null>;
      response: Record<string, unknown>;
    }>(cacheKey);
    if (cached && cached.team_source_revision === teamSourceRevision &&
        JSON.stringify(cached.event_revisions) === JSON.stringify(eventRevisions) &&
        JSON.stringify(cached.event_source_revisions) === JSON.stringify(eventSourceRevisions) &&
        JSON.stringify(cached.comparison_input_updated_ats) === JSON.stringify(comparisonInputUpdatedAts)) {
      await this.storage.put(cacheKey, { ...cached, checkedAt: Date.now() });
      const collectionState = (cached.response.collection as Record<string, unknown> | undefined)?.state;
      return Response.json(cached.response, {
        headers: {
          "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store",
          "X-FieldView-Analytics-Status": collectionState === "complete" ? "complete" : "partial",
        },
      });
    }

    const eventResults = await Promise.all(events.map(async (event) => {
      const eventState = await this.storage.get<FieldViewTeamEventState>(TEAM_EVENT_STATE_PREFIX + event.key);
      const inputs = await this.storage.get<{ team_source_revision: number; event_source_revision: number; comparison_input_updated_at: number }>(TEAM_EVENT_STATE_PREFIX + event.key + ":inputs");
      const current = Boolean(eventState?.analytics && inputs?.team_source_revision === teamSourceRevision &&
        inputs?.event_source_revision === eventSourceRevisions[event.key] &&
        inputs?.comparison_input_updated_at === comparisonInputUpdatedAts[event.key]);
      const analytics = current ? eventState!.analytics as FieldViewTeamEventAnalytics : null;
      return {
        event: { key: event.key, name: event.name, shortName: event.event_code ?? null, startDate: event.start_date },
        status: current ? "ready" as const : "pending" as const,
        analytics,
      };
    }));
    const seasonEvidence: SeasonMatchEvidence[] = eventResults.flatMap((entry) =>
      (entry.analytics?.match_evidence ?? []).map((match) => ({ ...match, event: entry.event })),
    );
    const diagnostics = buildSeasonDiagnostics(seasonEvidence);
    const ready = eventResults.filter((entry) => entry.analytics !== null);
    const completedMatches = ready.reduce((sum, entry) =>
      sum + (entry.analytics?.performance?.completed_matches ?? 0), 0);
    const matchesSeen = ready.reduce((sum, entry) =>
      sum + (entry.analytics?.performance?.matches_seen ?? 0), 0);
    const result = {
      team: Number(this.teamKey.replace(/^frc/i, "")),
      year,
      eventCount: events.length,
      analyzedEventCount: ready.length,
      matchCount: completedMatches,
      matchesSeen,
      events: eventResults,
      summary: diagnostics.overall,
      phaseSummaries: diagnostics.phaseSummaries,
      eliminationShift: diagnostics.eliminationShift,
      residualPattern: diagnostics.residualPattern,
      anomalySummary: diagnostics.anomalySummary,
      anomalies: diagnostics.anomalies,
      collection: {
        state: ready.length === events.length ? "complete" : ready.length > 0 ? "partial" : "pending",
        analyzedEvents: ready.length,
        totalEvents: events.length,
        updatedAt: Date.now(),
      },
    };
    // A partial failed refresh must not replace an existing last-good season
    // analytics publication. Initial publication may be explicitly partial.
    if (cached && ready.length < events.length) {
      return Response.json(cached.response, {
        headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "X-FieldView-Analytics-Status": "stale" },
      });
    }
    await this.storage.put(cacheKey, {
      team_source_revision: teamSourceRevision,
      event_revisions: eventRevisions,
      event_source_revisions: eventSourceRevisions,
      comparison_input_updated_ats: comparisonInputUpdatedAts,
      checkedAt: Date.now(),
      response: result,
    });
    return Response.json(result, {
      headers: {
        "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store",
        "X-FieldView-Analytics-Status": ready.length === events.length ? "complete" : "partial",
      },
    });
  }

  private async snapshot(year: number, request?: Request): Promise<Response> {
    const resources = this.endpoints(year);
    const now = Date.now();
    const inputSignature = (states: Array<TeamEndpointState<unknown> | undefined>) => JSON.stringify(
      states.map((state) => state ? [
        state.revision,
        state.status,
        state.lastFetchedAt,
        state.expiresAt,
        state.etag,
        state.expiresAt !== null && state.expiresAt < now,
      ] : null),
    );
    const publicationKey = `team-state:${year}:publication`;
    const legacyStateKey = `team-state:${year}`;
    const inputs = await this.storage.transaction(async (tx) => ({
      states: await Promise.all(resources.map(({ endpoint }) =>
        tx.get<TeamEndpointState<unknown>>(endpointKey(endpoint)))),
      revision: await tx.get<number>("snapshot-revision") ?? 0,
    }));
    const signature = inputSignature(inputs.states);
    const representationSignature = JSON.stringify(inputs.states.map((state) => state ? [
      state.revision, state.lastFetchedAt, state.etag,
    ] : null));
    const cached = await this.storage.get<{
      input_signature: string;
      representation_signature?: string;
      state: ReturnType<typeof normalizeFieldViewTeamState>;
    }>(publicationKey);
    const signatureHash = await hashSignature(signature);
    const etag = 'W/"fv-team-snapshot-v1-' + year + '-' + inputs.revision + '-' + signatureHash + '"';
    const responseHeaders = {
      "X-FieldView-Snapshot-Version": String(inputs.revision),
      ETag: etag,
      "Cache-Control": "private, no-cache",
    };
    if (etagMatches(request?.headers.get("If-None-Match") ?? null, etag)) {
      return new Response(null, { status: 304, headers: responseHeaders });
    }
    if (cached?.input_signature === signature) {
      this.publishedSnapshots.set(year, cached);
      return Response.json(cached.state, { headers: responseHeaders });
    }
    const failedInput = inputs.states.some((state) => state?.status === "failed");
    if (cached && failedInput &&
        (cached.representation_signature === undefined ||
          cached.representation_signature === representationSignature)) {
      // Provider failure is not a new publication. Keep serving the previous
      // last-good snapshot; public reads expose it as stale and retry locally.
      this.publishedSnapshots.set(year, cached);
      return Response.json(cached.state, {
        headers: { ...responseHeaders, "X-FieldView-Publication-Status": "stale" },
      });
    }

    const [team, districts, events, media, statboticsYear, statboticsEvents, frcColors] = inputs.states;
    const teamSource = metadata(team, now), districtSource = metadata(districts, now);
    const eventSource = metadata(events, now), mediaSource = metadata(media, now);
    const statboticsYearSource = metadata(statboticsYear, now), statboticsEventsSource = metadata(statboticsEvents, now);
    const frcColorsSource = metadata(frcColors, now);
    const snapshot = normalizeFieldViewTeamState({ team_key: this.teamKey, year,
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

    // Publish only if the provider inputs still match the exact read set used
    // to build this object. The publication and compatibility state key move
    // together in one transaction, so readers never observe a partial state.
    const published = await this.storage.transaction(async (tx) => {
      const currentStates = await Promise.all(resources.map(({ endpoint }) =>
        tx.get<TeamEndpointState<unknown>>(endpointKey(endpoint))));
      if (inputSignature(currentStates) !== signature) return false;
      await tx.put(publicationKey, { input_signature: signature, representation_signature: representationSignature, state: snapshot });
      // The publication is the single canonical persisted TeamState record.
      // Remove the legacy duplicate in the same transaction as replacement.
      await tx.delete(legacyStateKey);
      return true;
    });
    if (!published) return this.snapshot(year, request);

    this.publishedSnapshots.set(year, { input_signature: signature, representation_signature: representationSignature, state: snapshot });
    return Response.json(snapshot, { headers: responseHeaders });
  }
  private async pollResourceNow(resource: TeamResource): Promise<
    { success: boolean; status: string; revision: number; last_fetched_at: number | null; http_status: number | null; last_error: string | null }
  > {
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

  private async notifyEventRuntimeStateChange(
    eventKey: string,
    teamEventRevision: number,
  ): Promise<void> {
    if (!this.env.EVENT_RUNTIME || !this.env.RUNTIME_ADMIN_TOKEN) return;
    const stub = this.env.EVENT_RUNTIME.get(this.env.EVENT_RUNTIME.idFromName(eventKey));
    await stub.fetch(new Request("https://event-runtime/team-state-changed", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
        "X-FieldView-Event-Key": eventKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        team_key: this.teamKey,
        team_state_revision: await this.storage.get<number>("snapshot-revision") ?? 0,
        team_event_revision: teamEventRevision,
      }),
    }));
  }

  private async notifyEventsOfSeasonStateChange(year: number): Promise<void> {
    if (!this.env.EVENT_RUNTIME || !this.env.RUNTIME_ADMIN_TOKEN) return;
    const persisted = await this.storage.list<FieldViewTeamEventState>({ prefix: TEAM_EVENT_STATE_PREFIX });
    const active = await this.storage.get<Record<string, ActiveEventMembership>>(ACTIVE_EVENTS_KEY) ?? {};
    const eventKeys = new Set<string>([
      ...[...persisted.keys()].map((key) => key.slice(TEAM_EVENT_STATE_PREFIX.length)).filter((key) => /^[0-9]{4}[a-zA-Z0-9_-]+$/.test(key)),
      ...Object.entries(active).filter(([, membership]) => membership.year === year).map(([eventKey]) => eventKey),
    ]);
    const relevant = [...eventKeys].filter((eventKey) => Number(eventKey.slice(0, 4)) === year);
    await Promise.all(relevant.map(async (eventKey) => {
      try {
        await this.notifyEventRuntimeStateChange(
          eventKey,
          await this.storage.get<number>(TEAM_EVENT_REVISION_PREFIX + eventKey) ?? 0,
        );
      } catch {
        // EventRuntime reconciliation is recoverable through its next scheduled refresh.
      }
    }));
  }

  async alarm(): Promise<void> {
    if (!(await this.restoreIdentity())) return;
    // A Durable Object alarm may be the first invocation after a deployment.
    // Apply the same legacy recurring-Statbotics cleanup as ordinary requests.
    await this.clearRecurringStatboticsTasks();
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
      const manualEndpoints = new Set(manualDue.map((item) => item.endpoint));
      const ready = dueTasks.filter((task) => !manualEndpoints.has(task.endpoint));
      for (const task of ready) {
        const next = { ...task, attempts: task.attempts + 1 };
        const retryAt = now + Math.min(3_600_000, 30_000 * (2 ** Math.min(next.attempts - 1, 6)));
        await tx.put(taskKey(task.endpoint), { ...next, dueAt: retryAt });
      }
      if (manualDue.length > 0) {
        const dueEndpoints = new Set(manualDue.map((item) => item.endpoint));
        await tx.put(MANUAL_QUEUE_KEY, queued.map((item) =>
          dueEndpoints.has(item.endpoint) ? { ...item, dueAt: now + 60_000 } : item));
      }
      await this.rearm(tx);
      return { ready, manualDue };
    });
    // Keep one provider request in flight per TeamRuntime alarm.
    for (const item of due.manualDue) {
      const resource = this.endpoints(item.year).find((candidate) => candidate.endpoint === item.endpoint);
      if (!resource) continue;
      const previous = await this.storage.get<TeamEndpointState<unknown>>(endpointKey(resource.endpoint));
      const result = await this.pollResourceNow(resource);
      const current = await this.storage.get<TeamEndpointState<unknown>>(endpointKey(resource.endpoint));
      if (result.status !== "failed" && current?.revision !== previous?.revision && isStatboticsRefreshTrigger(resource)) {
        await this.enqueueManualPolls(this.endpoints(item.year).filter((candidate) => candidate.provider === "statbotics"), item.year, false);
      }
      const retryableFailure = result.status === "failed";
      const retryAt = Date.now() + Math.min(60_000, 1_000 * (2 ** Math.min(item.attempts, 6)));
      await this.storage.transaction(async (tx) => {
        const queue = await tx.get<ManualTeamPollRequest[]>(MANUAL_QUEUE_KEY) ?? [];
        const next = queue.filter((queued) => queued.endpoint !== item.endpoint);
        if (retryableFailure && item.attempts < 8) {
          // A provider failure is retried without discarding the last-good representation.
          next.push({ ...item, dueAt: retryAt, attempts: item.attempts + 1 });
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
      }
      const outcome = await this.storage.transaction(async (tx) => {
        const key = endpointKey(task.endpoint), latest = await tx.get<TeamEndpointState<unknown>>(key) ?? initial;
        const next = applyPollResponse(latest, requestState, result, Date.now(), (_current, fetched) => fetched);
        await tx.put(key, {
          ...next,
          lastHttpStatus: "httpStatus" in result ? result.httpStatus : result.status === "modified" ? 200 : latest.lastHttpStatus ?? null,
          lastError: "error" in result ? result.error : null,
        });
        const revisionChanged = next.revision !== latest.revision;
        if (revisionChanged) {
          await tx.put("snapshot-revision", (await tx.get<number>("snapshot-revision") ?? 0) + 1);
        }
        return { failed: result.status === "failed", revisionChanged };
      });
      const key = taskKey(task.endpoint);
      await this.storage.transaction(async (tx) => {
        const current = await tx.get<TeamPollTask>(key);
        // An administrator may have replaced this task while its poll ran.
        if (!current || current.generation !== task.generation) {
          await this.rearm(tx);
          return;
        }
        await tx.put(key, outcome.failed
          ? { ...current, dueAt: Date.now() + Math.min(3_600_000, 30_000 * (2 ** Math.min(task.attempts - 1, 6))), attempts: task.attempts }
          : { ...current, dueAt: Date.now() + task.intervalMs, attempts: 0 });
        await this.rearm(tx);
      });
      if (!outcome.failed && outcome.revisionChanged && isStatboticsRefreshTrigger({ provider: task.provider, endpoint: task.endpoint })) {
        const endpointParts = task.endpoint.split("/");
        const year = Number(endpointParts[4] ?? new Date().getUTCFullYear());
        await this.enqueueManualPolls(this.endpoints(year).filter((candidate) => candidate.provider === "statbotics"), year, false);
      }
    }
    const activeEvents = await this.storage.get<Record<string, ActiveEventMembership>>(ACTIVE_EVENTS_KEY) ?? {};
    const candidateYears = new Set<number>([
      new Date().getUTCFullYear(),
      ...due.manualDue.map((item) => item.year),
      ...Object.values(activeEvents).map((item) => item.year),
    ]);
    const currentYear = new Date().getUTCFullYear();
    const refreshYears = new Set<number>(due.manualDue.map((item) => item.year));
    // A runtime first reached through a historical season still owns a
    // current-season TeamState. Materialize its initial empty/partial
    // publication during background alarm work, never in the public read.
    if (!(await this.storage.get("team-state:" + currentYear + ":publication"))) {
      refreshYears.add(currentYear);
    }
    for (const task of due.ready) {
      for (const year of candidateYears) {
        if (this.endpoints(year).some((resource) => resource.endpoint === task.endpoint)) {
          refreshYears.add(year);
        }
      }
    }
    for (const year of refreshYears) {
      const publicationKey = "team-state:" + year + ":publication";
      const previous = (await this.storage.get<{ state: unknown }>(publicationKey))?.state;
      await this.snapshot(year);
      const current = (await this.storage.get<{ state: unknown }>(publicationKey))?.state;
      if (JSON.stringify(previous) !== JSON.stringify(current)) {
        await this.notifyEventsOfSeasonStateChange(year);
      }
    }

    const analyticsJobs = await this.storage.list<number>({ prefix: SEASON_ANALYTICS_DUE_PREFIX });
    const nextAnalyticsJob = [...analyticsJobs.entries()]
      .filter(([, dueAt]) => dueAt <= Date.now())
      .sort((a, b) => a[1] - b[1])[0];
    if (nextAnalyticsJob) {
      const [jobKey] = nextAnalyticsJob;
      const year = Number(jobKey.slice(SEASON_ANALYTICS_DUE_PREFIX.length));
      try {
        const response = await this.buildSeasonAnalyticsResponse(year);
        if (response.ok && response.headers.get("X-FieldView-Analytics-Status") === "complete") {
          await this.storage.delete(jobKey);
        } else {
          await this.storage.put(jobKey, Date.now() + 60_000);
        }
      } catch {
        await this.storage.put(jobKey, Date.now() + 60_000);
      }
    }
    await this.storage.transaction((tx) => this.rearm(tx));
  }
}
