import { DurableObjectBase } from "./durable-object-base.ts";
import { TBAApiClient } from "../../../../packages/providers/tba/src/client.ts";
import { TBA_ENDPOINTS } from "../../../../packages/providers/tba/src/endpoints.ts";
import { StatboticsApiClient } from "../../../../packages/providers/statbotics/src/client.ts";
import { STATBOTICS_ENDPOINTS } from "../../../../packages/providers/statbotics/src/endpoints.ts";
import { FRCColorsApiClient } from "../../../../packages/providers/frc-colors/src/client.ts";
import { FRC_COLORS_ENDPOINTS } from "../../../../packages/providers/frc-colors/src/endpoints.ts";
import type { StatboticsTeamEvent, StatboticsTeamYear } from "../../../../packages/providers/statbotics/src/types.ts";
import type { FRCColorsTeam } from "../../../../packages/providers/frc-colors/src/types.ts";
import { applyPollResponse, createEndpointState, createPollRequestSnapshot, type EndpointState } from "./endpoint-state.ts";
import { validateRuntimeBootstrapBundle } from "./bootstrap.ts";
import type { DurableObjectStateLike, RuntimeEnvironment } from "./cloudflare.ts";
import { D1RecordStore } from "./d1-record-store.ts";
import type { TBADistrict, TBAMedia, TBAEvent, TBATeam } from "../../../../packages/providers/tba/src/types.ts";
import type { FieldViewSourceRecordMetadata } from "../../../../packages/domain/src/source-metadata.ts";
import { normalizeFieldViewTeamState } from "../../../../packages/domain/src/normalization/team-state.ts";
import { normalizeFieldViewTeamEventState } from "../../../../packages/domain/src/normalization/team-event-state.ts";
import type { FieldViewEventState } from "../../../../packages/domain/src/event.ts";
import type { FieldViewTeamEventState, FieldViewTeamState } from "../../../../packages/domain/src/team.ts";
import type { FieldViewEventTeamSeasonComparisonInput, FieldViewAnalyticsInputRecord } from "../../../../packages/domain/src/analytics.ts";
import { calculateCanonicalTeamEventAnalytics } from "../../../../packages/analytics/src/canonical-match-analytics.ts";
import { buildSeasonDiagnostics } from "../../../../packages/analytics/src/season-diagnostics.ts";
import type { SeasonMatchEvidence } from "../../../../packages/analytics/src/season-diagnostics.ts";
import type { FieldViewTeamEventAnalytics } from "../../../../packages/domain/src/analytics.ts";
import { EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION, isTeamEventAnalyticsCommand, isTeamEventAnalyticsAcknowledgement, type TeamEventAnalyticsResult } from "./analytics-orchestration-contract.ts";

type TeamProvider = "tba" | "statbotics" | "frc-colors";
interface ActiveEventMembership { year: number; updatedAt: number; }
const ACTIVE_EVENTS_KEY = "activity:active-events";
const TEAM_EVENT_STATE_PREFIX = "team-event-state:";
const TEAM_EVENT_REVISION_PREFIX = "team-event-revision:";
export interface TeamResource { provider: TeamProvider; endpoint: string; }
interface TeamEndpointState<T> extends EndpointState<T> {
  lastHttpStatus?: number | null;
  lastError?: string | null;
}
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

function isRuntimeAdminAuthorized(request: Request, env: RuntimeEnvironment): boolean {
  const token = env.RUNTIME_ADMIN_TOKEN;
  return Boolean(token && request.headers.get("Authorization") === "Bearer " + token);
}

const endpointKey = (endpoint: string) => ENDPOINT_PREFIX + endpoint;
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
export class TeamRuntime extends DurableObjectBase {
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
    super(state, env);
    this.storage = state.storage; this.env = env; this.teamKey = teamKey;
    this.api = new TBAApiClient({ apiKey: env.TBA_API_KEY, ...(env.fetcher ? { fetch: env.fetcher } : {}) });
    this.statboticsApi = new StatboticsApiClient({
      ...(env.STATBOTICS_API_BASE_URL ? { baseUrl: env.STATBOTICS_API_BASE_URL } : {}),
      ...(env.fetcher ? { fetch: env.fetcher } : {}),
    });
    this.frcColorsApi = new FRCColorsApiClient(env.fetcher ? { fetch: env.fetcher } : {});
    this.hydrationMode = state.blockConcurrencyWhile ? "platform-barrier" : "storage-backed";
    // Restore only this TeamRuntime's persisted identity and publications.
    // Provider refresh and cross-runtime work are dispatched explicitly by the coordinator.
    this.activation = state.blockConcurrencyWhile
      ? state.blockConcurrencyWhile(async () => {
          const [storedKey, publications] = await Promise.all([
            this.storage.get<string>("team-key"),
            this.storage.list<{ input_signature: string; representation_signature?: string; state: ReturnType<typeof normalizeFieldViewTeamState> }>({ prefix: "team-state:" }),
          ]);
          if (storedKey && !this.teamKey) this.teamKey = storedKey;
          for (const [key, publication] of publications) {
            const match = /^team-state:(\d+):publication$/.exec(key);
            if (match && publication?.state) {
              const year = Number(match[1]);
              this.publishedSnapshots.set(year, publication);
            }
          }
          // Legacy duplicate raw-snapshot keys remain untouched during activation.
          // Persistent cleanup requires an explicit migration operation.
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
  private async currentSeasonYear(): Promise<number | null> {
    const store = this.env.DISCOVERY_STORAGE ?? (this.env.DB ? new D1RecordStore(this.env.DB) : null);
    if (!store) return null;
    const raw = await store.get<string>("discovery/current-season.json");
    if (typeof raw !== "string") return null;
    const current = JSON.parse(raw) as { year?: unknown };
    return current && Number.isInteger(current.year) && Number(current.year) >= 1992 && Number(current.year) <= 2200
      ? Number(current.year) : null;
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
  async fetch(request: Request): Promise<Response> {
    await this.activation;
    const url = new URL(request.url);
    const admin = Boolean(this.env.RUNTIME_ADMIN_TOKEN) && request.headers.get("Authorization") === "Bearer " + this.env.RUNTIME_ADMIN_TOKEN;
    const publicRead = request.method === "GET" && url.pathname === "/snapshot";
    const publicEventStateRead = request.method === "GET" && url.pathname === "/event-state";
    const publicSeasonAnalyticsRead = request.method === "GET" && url.pathname === "/season-analytics";
    const readinessRequest = request.method === "POST" && url.pathname === "/readiness";
    const pendingAnalyticsRead = request.method === "GET" && url.pathname === "/pending-event-analytics";
    const analyticsSeasonInputRead = request.method === "GET" && url.pathname === "/analytics-season-input";
    const analyticsSeasonInputPrepare = request.method === "POST" && url.pathname === "/analytics-season-input/prepare";
    if (!admin && !publicRead && !publicEventStateRead && !publicSeasonAnalyticsRead) return Response.json({ error: "Unauthorized" }, { status: 401 });
    // Public reads must not bind identity or perform migration cleanup writes.
    // Entity identity is established by scheduler/admin initialization before a
    // runtime is exposed to public readers.
    const diagnosticsRead = request.method === "GET" && url.pathname === "/state";
    if (publicRead || publicSeasonAnalyticsRead || publicEventStateRead || diagnosticsRead || readinessRequest || pendingAnalyticsRead || analyticsSeasonInputRead) {
      if (diagnosticsRead && !isRuntimeAdminAuthorized(request, this.env)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (!(await this.restoreIdentity())) {
        return Response.json({ error: "Team runtime is not registered" }, {
          status: 404, headers: { "Cache-Control": "no-store" },
        });
      }
      if (request.headers.get("X-FieldView-Team-Key") !== this.teamKey) {
        return Response.json({ error: "Invalid or mismatched team identity" }, { status: 400 });
      }
    } else {
      if (!(await this.bindTeamKey(request))) return Response.json({ error: "Invalid or mismatched team identity" }, { status: 400 });
    }
    if (request.method === "POST" && url.pathname === "/register") {
      return Response.json({ team_key: this.teamKey, registered: true }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const yearText = url.searchParams.get("year") ?? (url.pathname === "/event-state" ? url.searchParams.get("event_key")?.slice(0, 4) ?? null : null);
    const year = yearText === null ? await this.currentSeasonYear() : Number(yearText);
    if (year === null) return Response.json({ error: "TBA current season is unavailable" }, { status: 503 });
    if (!Number.isInteger(year) || year < 1992 || year > 2200) return Response.json({ error: "Invalid season year" }, { status: 400 });

    if (request.method === "POST" && url.pathname === "/bootstrap") {
      const body: unknown = await request.json().catch(() => null);
      if (!validateRuntimeBootstrapBundle(body, { kind: "team", key: this.teamKey, year })) {
        return Response.json({ error: "Invalid team bootstrap bundle" }, { status: 400 });
      }
      const allowed = new Set(this.endpoints(year).map((resource) => resource.endpoint));
      if (body.resources.length !== allowed.size || body.resources.some((resource) => !allowed.has(resource.endpoint))) {
        return Response.json({ error: "Bootstrap contains an unrecognized team resource" }, { status: 400 });
      }
      const receipt = await this.storage.transaction(async (tx) => {
        const receiptKey = "bootstrap:accepted:" + year;
        const previous = await tx.get<{ bootstrap_id: string; acquired_at: number; snapshot_revision: number; publication_status: "complete" | "partial" | "failed" }>(receiptKey);
        if (previous?.bootstrap_id === body.bootstrap_id) return { ...previous, duplicate: true };
        if (previous && previous.acquired_at > body.acquired_at) return null;
        const existing = await Promise.all(body.resources.map((resource) => tx.get<TeamEndpointState<unknown>>(endpointKey(resource.endpoint))));
        if (existing.some((resource) => Boolean(resource && (
            (resource.lastFetchedAt !== null && resource.lastFetchedAt > body.acquired_at) ||
            (resource.lastWebhookAt !== null && resource.lastWebhookAt > body.acquired_at)
          )))) return null;
        for (const resource of body.resources) await tx.put(endpointKey(resource.endpoint), {
          ...resource, lastHttpStatus: resource.status === "available" ? 200 : null, lastError: null,
        });
        const snapshotRevision = (await tx.get<number>("snapshot-revision") ?? 0) + 1;
        await tx.put("snapshot-revision", snapshotRevision);
        const status = body.resources.every((resource) => resource.status === "available") ? "complete" as const
          : body.resources.some((resource) => resource.lastFetchedAt !== null) ? "partial" as const : "failed" as const;
        const next = { bootstrap_id: body.bootstrap_id, acquired_at: body.acquired_at, snapshot_revision: snapshotRevision, publication_status: status };
        await tx.put(receiptKey, next);
        return { ...next, duplicate: false };
      });
      if (!receipt) return Response.json({ error: "Bootstrap is older than runtime data" }, { status: 409 });
      if (!receipt.duplicate) await this.snapshot(year);
      return Response.json({
        bootstrap_id: receipt.bootstrap_id, accepted: true, duplicate: receipt.duplicate,
        kind: "team", key: this.teamKey, year, snapshot_revision: receipt.snapshot_revision,
        publication_status: receipt.publication_status,
      });
    }

    if (pendingAnalyticsRead) {
      const records = await this.storage.list<FieldViewTeamEventState>({ prefix: TEAM_EVENT_STATE_PREFIX });
      const pending = [];
      for (const [key, state] of records) {
        const eventKey = key.slice(TEAM_EVENT_STATE_PREFIX.length);
        if (!/^[0-9]{4}[a-zA-Z0-9_-]+$/.test(eventKey) ||
            Number(eventKey.slice(0, 4)) !== year ||
            state?.event_key !== eventKey || state?.team_key !== this.teamKey) continue;
        const inputs = await this.storage.get<{
          event_source_revision: number;
          team_source_revision: number;
          comparison_input_updated_at: number;
          calculated_at?: number;
          publication_status?: "pending" | "published";
        }>(key + ":inputs");
        if (inputs?.publication_status !== "pending") continue;
        pending.push({
          event_key: eventKey,
          team_event_revision: await this.storage.get<number>(TEAM_EVENT_REVISION_PREFIX + eventKey) ?? 0,
          event_source_revision: inputs.event_source_revision,
          team_source_revision: inputs.team_source_revision,
          comparison_input_updated_at: inputs.comparison_input_updated_at,
          calculated_at: Number.isSafeInteger(inputs.calculated_at) ? inputs.calculated_at : null,
        });
      }
      pending.sort((a, b) => a.event_key.localeCompare(b.event_key));
      return Response.json({ team_key: this.teamKey, year, pending }, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (publicSeasonAnalyticsRead) {
      const teamPublication = await this.storage.get<{ input_signature?: string; state?: unknown }>("team-state:" + year + ":publication");
      const teamState = teamPublication?.state;
      if (!teamPublication || !teamState) {
        return Response.json({ error: "TeamState publication not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
      }
      if (typeof teamPublication.input_signature !== "string" || typeof teamState !== "object" || Array.isArray(teamState) ||
          (teamState as Record<string, unknown>).team_key !== this.teamKey ||
          (teamState as Record<string, unknown>).year !== year ||
          !(teamState as Record<string, unknown>).sources ||
          typeof (teamState as Record<string, unknown>).sources !== "object" ||
          Array.isArray((teamState as Record<string, unknown>).sources)) {
        return Response.json({ error: "Invalid TeamState publication", team_key: this.teamKey, year }, {
          status: 500, headers: { "Cache-Control": "no-store" },
        });
      }
      const cacheKey = "team-season-analytics:" + year;
      const cached = await this.storage.get<{
        team_source_revision: number;
        event_revisions: Record<string, number>;
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
      const resources = this.endpoints(year);
      const states = await Promise.all(resources.map(({ endpoint }) =>
        this.storage.get<TeamEndpointState<unknown>>(endpointKey(endpoint))));
      const now = Date.now();
      const resourcesStale = resources.some((resource, index) => {
        if (resource.provider === "statbotics") return false;
        const state = states[index];
        return !state || (state.lastFetchedAt === null && state.status !== "unavailable") ||
          state.status === "failed" || state.status === "stale" ||
          (state.expiresAt !== null && state.expiresAt <= now);
      });
      if (!cached) {
        return Response.json({ error: "Team season analytics publication not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
      }
      return Response.json(cached.response, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
          "X-FieldView-Analytics-Status": stale ? "stale" : partial ? "partial" : "complete",
          "X-FieldView-Analytics-Revalidation": stale || partial || resourcesStale ? "required" : "idle",
          "X-FieldView-Analytics-Checked-At": String(checkedAt),
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/season-analytics/refresh") {
      if (!isRuntimeAdminAuthorized(request, this.env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      // Analytics refresh is an explicit command. Public GET remains a
      // side-effect-free read of the last published aggregate.
      return this.buildSeasonAnalyticsResponse(year);
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
      if (!publication) return Response.json({ error: "TeamState publication not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
      if (typeof publication.input_signature !== "string" || !publishedState || publishedState.team_key !== this.teamKey || publishedState.year !== year ||
          !publishedState.sources || typeof publishedState.sources !== "object" || Array.isArray(publishedState.sources)) {
        return Response.json({ error: "Invalid TeamState publication", team_key: this.teamKey, year }, {
          status: 500, headers: { "Cache-Control": "no-store" },
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

    // Only explicit mutation commands may materialize TeamState. All GET
    // inspection paths, readiness, and analytics-input reads/preparation stay
    // outside this implicit initialization path.
    const skipAutomaticInitialization = publicRead || publicSeasonAnalyticsRead || publicEventStateRead ||
      diagnosticsRead || readinessRequest || pendingAnalyticsRead || analyticsSeasonInputRead || analyticsSeasonInputPrepare;
    const currentYear = pendingAnalyticsRead ? null : await this.currentSeasonYear();
    if (!skipAutomaticInitialization) {
      let requestedYearInitialized = false;
      if (currentYear !== null) {
        const currentPublication = await this.storage.get<unknown>("team-state:" + currentYear + ":publication");
        if (!currentPublication) {
          await this.snapshot(currentYear);
          requestedYearInitialized = currentYear === year;
        }
      }
      if (!requestedYearInitialized) await this.snapshot(year);
    }
    if (publicEventStateRead) {
      const eventKey = url.searchParams.get("event_key") ?? "";
      if (!/^[0-9]{4}[a-zA-Z0-9_-]+$/.test(eventKey)) return Response.json({ error: "Invalid event key" }, { status: 400 });
      const stateKey = TEAM_EVENT_STATE_PREFIX + eventKey;
      const storedState = await this.storage.get<FieldViewTeamEventState & {
        team?: import("../../../../packages/domain/src/team.ts").FieldViewTeam | null;
        event_team?: import("../../../../packages/domain/src/event.ts").FieldViewEventTeam | null;
        matches?: import("../../../../packages/domain/src/match.ts").FieldViewMatch[] | null;
      }>(stateKey);
      if (!storedState) return Response.json({ error: "TeamEventState publication not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
      const inputs = await this.storage.get<{ event_source_revision: number; team_source_revision: number; comparison_input_updated_at: number; publication_status?: "pending" | "published" }>(stateKey + ":inputs");
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
      // Legacy compatibility is normalized in the response only. Public reads never migrate or rewrite storage.
      return Response.json(state, {
        headers: {
          "X-FieldView-Team-Event-Revision": String(await this.storage.get<number>(TEAM_EVENT_REVISION_PREFIX + eventKey) ?? 0),
          "X-FieldView-Analytics-Publication-Status": inputs?.publication_status ?? "published",
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
      if (!isTeamEventAnalyticsCommand(body)) {
        return Response.json({ error: "Invalid or unsupported team event analytics command" }, { status: 400 });
      }
      const input = body;
      const eventKey = input.event_key;
      const eventState = input.event_state;
      const comparisonInput = input.comparison_input;
      const eventSourceRevision = input.event_source_revision;
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
      const priorInputs = await this.storage.get<{ event_source_revision: number; team_source_revision: number; comparison_input_updated_at: number; publication_status?: "pending" | "published" }>(stateKey + ":inputs");
      if (priorInputs && ((eventSourceRevision as number) < priorInputs.event_source_revision ||
          teamSourceRevision < priorInputs.team_source_revision || comparisonInput.updated_at < priorInputs.comparison_input_updated_at)) {
        return Response.json({ error: "Stale event analytics input" }, { status: 409 });
      }
      if ((await this.storage.get<number>("snapshot-revision") ?? 0) !== teamSourceRevision) {
        return Response.json({ error: "Team season state changed during calculation" }, { status: 409 });
      }
      const prior = await this.storage.get<FieldViewTeamEventState>(stateKey);
      if (prior && JSON.stringify(prior) === JSON.stringify(result)) {
        const revision = await this.storage.transaction(async (tx) => {
          if ((await tx.get<number>("snapshot-revision") ?? 0) !== teamSourceRevision) return null;
          const current = await tx.get<FieldViewTeamEventState>(stateKey);
          const currentInputs = await tx.get<{ event_source_revision: number; team_source_revision: number; comparison_input_updated_at: number; publication_status?: "pending" | "published" }>(stateKey + ":inputs");
          if (!current || JSON.stringify(current) !== JSON.stringify(result) ||
              (currentInputs && ((eventSourceRevision as number) < currentInputs.event_source_revision ||
                teamSourceRevision < currentInputs.team_source_revision ||
                comparisonInput.updated_at < currentInputs.comparison_input_updated_at))) return null;
          const currentRevision = await tx.get<number>(revisionKey) ?? 0;
          // Even when calculated metrics are unchanged, advance the input
          // envelope so owner-local readers and future Workflows see the
          // latest comparison revision without inventing a state revision.
          await tx.put(stateKey + ":inputs", {
            event_source_revision: eventSourceRevision,
            team_source_revision: teamSourceRevision,
            comparison_input_updated_at: comparisonInput.updated_at,
            calculated_at: Date.now(),
            publication_status: "pending",
          });
          await tx.delete("team-season-analytics:" + year);
          return currentRevision;
        });
        if (revision === null) {
          return Response.json({ error: "Team analytics inputs changed during publication" }, { status: 409 });
        }
        const response: TeamEventAnalyticsResult = {
          contract_version: EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION,
          event_key: eventKey,
          team_key: this.teamKey,
          event_source_revision: eventSourceRevision,
          team_source_revision: teamSourceRevision,
          comparison_input_updated_at: comparisonInput.updated_at,
          team_event_revision: revision,
          state: result,
        };
        return Response.json(response, { headers: {
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
        if ((await tx.get<number>("snapshot-revision") ?? 0) !== teamSourceRevision) return null;
        const currentInputs = await tx.get<{ event_source_revision: number; team_source_revision: number; comparison_input_updated_at: number; publication_status?: "pending" | "published" }>(stateKey + ":inputs");
        if (currentInputs && ((eventSourceRevision as number) < currentInputs.event_source_revision ||
            teamSourceRevision < currentInputs.team_source_revision ||
            comparisonInput.updated_at < currentInputs.comparison_input_updated_at)) return null;
        const next = (await tx.get<number>(revisionKey) ?? 0) + 1;
        await tx.put(stateKey, result);
        await tx.put(revisionKey, next);
        await tx.put(stateKey + ":inputs", {
          event_source_revision: eventSourceRevision,
          team_source_revision: teamSourceRevision,
          comparison_input_updated_at: comparisonInput.updated_at,
          calculated_at: Date.now(),
          publication_status: "pending",
        });
        await tx.delete("team-season-analytics:" + year);
        return next;
      });
      if (revision === null) {
        return Response.json({ error: "Team analytics inputs changed during publication" }, { status: 409 });
      }
      const response: TeamEventAnalyticsResult = {
        contract_version: EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION,
        event_key: eventKey,
        team_key: this.teamKey,
        event_source_revision: eventSourceRevision,
        team_source_revision: teamSourceRevision,
        comparison_input_updated_at: comparisonInput.updated_at,
        team_event_revision: revision,
        state: result,
      };
      return Response.json(response, { headers: {
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
    if (request.method === "POST" && url.pathname === "/event-analytics/acknowledge") {
      const body: unknown = await request.json().catch(() => null);
      if (!isTeamEventAnalyticsAcknowledgement(body) || body.team_key !== this.teamKey) {
        return Response.json({ error: "Invalid team analytics publication acknowledgement" }, { status: 400 });
      }
      const stateKey = TEAM_EVENT_STATE_PREFIX + body.event_key;
      const inputsKey = stateKey + ":inputs";
      const revisionKey = TEAM_EVENT_REVISION_PREFIX + body.event_key;
      const year = Number(body.event_key.slice(0, 4));
      const outcome = await this.storage.transaction(async (tx) => {
        const [state, inputs, revision] = await Promise.all([
          tx.get<FieldViewTeamEventState>(stateKey),
          tx.get<{
            event_source_revision: number;
            team_source_revision: number;
            comparison_input_updated_at: number;
            publication_status?: "pending" | "published";
          }>(inputsKey),
          tx.get<number>(revisionKey),
        ]);
        if (!state || state.event_key !== body.event_key || state.team_key !== body.team_key ||
            !inputs || revision !== body.team_event_revision ||
            inputs.event_source_revision !== body.event_source_revision ||
            inputs.team_source_revision !== body.team_source_revision ||
            inputs.comparison_input_updated_at !== body.comparison_input_updated_at) return "stale" as const;
        if (inputs.publication_status === "published") return "already_published" as const;
        await tx.put(inputsKey, {
          ...inputs,
          publication_status: "published",
          published_at: Date.now(),
        });
        // Publication status is independently versioned by invalidating the
        // cached season aggregate; canonical TeamEventState revision is stable.
        await tx.delete("team-season-analytics:" + year);
        return "acknowledged" as const;
      });
      if (outcome === "stale") {
        return Response.json({ error: "Analytics acknowledgement does not match the current TeamEventState revision" }, { status: 409 });
      }
      return Response.json({
        event_key: body.event_key,
        team_key: body.team_key,
        team_event_revision: body.team_event_revision,
        publication_status: "published",
        acknowledged: outcome === "acknowledged",
        idempotent: outcome === "already_published",
      }, { headers: { "Cache-Control": "no-store" } });
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
      // Active-event membership is coordinator input only. The TeamRuntime
      // does not create recurring tasks or schedule provider work.
      return Response.json({ team_key: this.teamKey, active_events: Object.keys(activeEvents).sort(), active: value.active, changed });
    }
    if (request.method === "POST" && (url.pathname === "/refresh" || url.pathname === "/seed")) {
      const body: unknown = await request.json().catch(() => ({}));
      const resources = this.endpoints(year);
      const requested = body && typeof body === "object" && !Array.isArray(body) &&
        Array.isArray((body as Record<string, unknown>).endpoints)
        ? (body as Record<string, unknown>).endpoints as unknown[]
        : resources.filter((resource) => resource.provider !== "statbotics").map((resource) => resource.endpoint);
      if (!requested.every((endpoint) => typeof endpoint === "string" &&
          resources.some((resource) => resource.endpoint === endpoint))) {
        return Response.json({ error: "Refresh endpoints must belong to this team and season" }, { status: 400 });
      }
      const selected = resources.filter((resource) => requested.includes(resource.endpoint));
      const historyEndpoint = TBA_ENDPOINTS.teamEvents(this.teamKey, year);
      const prioritized = [
        ...selected.filter((resource) => resource.provider === "tba" && resource.endpoint === historyEndpoint),
        ...selected.filter((resource) => resource.endpoint !== historyEndpoint),
      ];
      const previousTeamStateRevision = await this.storage.get<number>("snapshot-revision") ?? 0;
      const previousPublication = await this.storage.get<{ input_signature?: string; state?: unknown }>("team-state:" + year + ":publication");
      const previousResourceRevisions = new Map<string, number>();
      for (const resource of prioritized) {
        const state = await this.storage.get<TeamEndpointState<unknown>>(endpointKey(resource.endpoint));
        previousResourceRevisions.set(resource.endpoint, state?.revision ?? 0);
      }
      const results: Array<{ endpoint: string; success: boolean; status: string; revision: number; last_fetched_at: number | null; http_status: number | null; last_error: string | null }> = [];
      for (const resource of prioritized) {
        const result = await this.pollResourceNow(resource);
        results.push({ endpoint: resource.endpoint, ...result });
      }
      const tbaRepresentationChanged = prioritized.some((resource) => resource.provider === "tba" &&
        (results.find((result) => result.endpoint === resource.endpoint)?.revision ?? 0) >
          (previousResourceRevisions.get(resource.endpoint) ?? 0));
      const alreadySelected = new Set(prioritized.map((resource) => resource.endpoint));
      const statboticsResources = resources.filter((resource) =>
        resource.provider === "statbotics" && !alreadySelected.has(resource.endpoint));
      const statboticsNeedsRefresh = tbaRepresentationChanged || (await Promise.all(
        statboticsResources.map(async (resource) => {
          const state = await this.storage.get<TeamEndpointState<unknown>>(endpointKey(resource.endpoint));
          return !state || state.status === "failed" || state.status === "stale" ||
            (state.expiresAt !== null && state.expiresAt <= Date.now());
        }),
      )).some(Boolean);
      if (statboticsNeedsRefresh) {
        for (const resource of statboticsResources) {
          const result = await this.pollResourceNow(resource);
          results.push({ endpoint: resource.endpoint, ...result });
        }
      }
      const teamStateRevision = await this.storage.get<number>("snapshot-revision") ?? 0;
      const teamStateChanged = teamStateRevision !== previousTeamStateRevision || !previousPublication;
      let snapshot: unknown = previousPublication?.state ?? null;
      if (teamStateChanged) {
        const snapshotResponse = await this.snapshot(year);
        snapshot = snapshotResponse.status === 200 ? await snapshotResponse.json() : null;
      }
      const persistedEventStates = teamStateChanged
        ? await this.storage.list<FieldViewTeamEventState>({ prefix: TEAM_EVENT_STATE_PREFIX })
        : new Map<string, FieldViewTeamEventState>();
      const activeEvents = teamStateChanged
        ? await this.storage.get<Record<string, ActiveEventMembership>>(ACTIVE_EVENTS_KEY) ?? {}
        : {};
      const affectedEventKeys = new Set<string>([
        ...[...persistedEventStates.keys()].map((key) => key.slice(TEAM_EVENT_STATE_PREFIX.length))
          .filter((key) => /^[0-9]{4}[a-zA-Z0-9_-]+$/.test(key) && Number(key.slice(0, 4)) === year),
        ...Object.entries(activeEvents).filter(([, membership]) => membership.year === year).map(([eventKey]) => eventKey),
      ]);
      const affectedEvents = await Promise.all([...affectedEventKeys].sort().map(async (event_key) => ({
        event_key,
        team_event_revision: await this.storage.get<number>(TEAM_EVENT_REVISION_PREFIX + event_key) ?? 0,
      })));
      return Response.json({
        scheduled: false,
        queued: false,
        attempted: true,
        team_key: this.teamKey,
        year,
        team_state_revision: teamStateRevision,
        affected_events: affectedEvents,
        snapshot,
        results,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method === "POST" && url.pathname === "/readiness") {
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
      const refreshRequired = !validState || staleResources.length > 0;
      const latest = await this.storage.get<{ input_signature?: string; state?: unknown }>("team-state:" + year + ":publication");
      const latestState = latest?.state as Record<string, unknown> | undefined;
      return Response.json({
        team_key: this.teamKey,
        year,
        state_valid: Boolean(latest && latestState?.team_key === this.teamKey && latestState?.year === year),
        stale_resources: staleResources,
        refresh_required: refreshRequired,
        refresh_dispatched: false,
        refresh_completed: false,
        results: [],
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method === "POST" && url.pathname === "/ingest-resource") {
      const body: unknown = await request.json().catch(() => null);
      const endpoint = body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).endpoint : null;
      const resource = typeof endpoint === "string" ? this.endpoints(year).find((item) => item.endpoint === endpoint) : undefined;
      if (!resource) return Response.json({ error: "Resource endpoint is not part of this team and season" }, { status: 400 });
      const previousRevision = await this.storage.get<number>("snapshot-revision") ?? 0;
      const previousPublication = await this.storage.get<{ input_signature?: string; state?: unknown }>("team-state:" + year + ":publication");
      const result = await this.pollResourceNow(resource);
      const teamStateRevision = await this.storage.get<number>("snapshot-revision") ?? 0;
      const teamStateChanged = teamStateRevision !== previousRevision || !previousPublication;
      let snapshot: unknown = previousPublication?.state ?? null;
      if (teamStateChanged) {
        const snapshotResponse = await this.snapshot(year);
        snapshot = snapshotResponse.status === 200 ? await snapshotResponse.json() : null;
      }
      const persistedEventStates = teamStateChanged
        ? await this.storage.list<FieldViewTeamEventState>({ prefix: TEAM_EVENT_STATE_PREFIX })
        : new Map<string, FieldViewTeamEventState>();
      const activeEvents = teamStateChanged
        ? await this.storage.get<Record<string, ActiveEventMembership>>(ACTIVE_EVENTS_KEY) ?? {}
        : {};
      const affectedEventKeys = new Set<string>([
        ...[...persistedEventStates.keys()].map((key) => key.slice(TEAM_EVENT_STATE_PREFIX.length))
          .filter((key) => /^[0-9]{4}[a-zA-Z0-9_-]+$/.test(key) && Number(key.slice(0, 4)) === year),
        ...Object.entries(activeEvents).filter(([, membership]) => membership.year === year).map(([eventKey]) => eventKey),
      ]);
      const affectedEvents = await Promise.all([...affectedEventKeys].sort().map(async (event_key) => ({
        event_key,
        team_event_revision: await this.storage.get<number>(TEAM_EVENT_REVISION_PREFIX + event_key) ?? 0,
      })));
      return Response.json({
        endpoint, queued: false, attempted: true, ...result,
        team_key: this.teamKey, year, team_state_revision: teamStateRevision,
        affected_events: affectedEvents, snapshot,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if ((request.method === "GET" && url.pathname === "/analytics-season-input") ||
        (request.method === "POST" && url.pathname === "/analytics-season-input/prepare")) {
      const year = Number(url.searchParams.get("year"));
      if (!Number.isInteger(year) || year < 1992 || year > 2200) {
        return Response.json({ error: "A valid season year is required" }, { status: 400 });
      }
      let teamState: FieldViewTeamState;
      let revision: number;
      if (request.method === "POST" && url.pathname === "/analytics-season-input/prepare") {
        // Preparing a canonical analytics input is an explicit Workflow command.
        // It may publish a normalized TeamState from already-owned endpoint data.
        const snapshot = await this.snapshot(year);
        if (!snapshot.ok) return snapshot;
        teamState = await snapshot.json() as FieldViewTeamState;
        revision = Number(snapshot.headers.get("X-FieldView-Snapshot-Version"));
      } else {
        // GET is inspection-only: it never materializes or rewrites TeamState.
        const publication = await this.storage.get<{
          input_signature?: string;
          representation_signature?: string;
          state?: FieldViewTeamState;
        }>("team-state:" + year + ":publication");
        if (!publication?.state) {
          return Response.json({ error: "TeamState analytics input not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
        }
        const current = await this.storage.transaction(async (tx) => ({
          revision: await tx.get<number>("snapshot-revision") ?? 0,
          states: await Promise.all(this.endpoints(year).map(({ endpoint }) =>
            tx.get<TeamEndpointState<unknown>>(endpointKey(endpoint)))),
        }));
        const now = Date.now();
        const inputSignature = JSON.stringify(current.states.map((state) => state ? [
          state.revision, state.status, state.lastFetchedAt, state.expiresAt, state.etag,
          state.expiresAt !== null && state.expiresAt < now,
        ] : null));
        const representationSignature = JSON.stringify(current.states.map((state) => state ? [
          state.revision, state.lastFetchedAt, state.etag,
        ] : null));
        if (typeof publication.input_signature !== "string" || publication.input_signature !== inputSignature ||
            typeof publication.representation_signature !== "string" ||
            publication.representation_signature !== representationSignature) {
          return Response.json({ error: "Published TeamState is stale; explicitly prepare the analytics input" }, {
            status: 409, headers: { "Cache-Control": "no-store" },
          });
        }
        teamState = publication.state;
        revision = current.revision;
      }
      if (!Number.isSafeInteger(revision) || revision < 0 || teamState.team_key !== this.teamKey ||
          teamState.year !== year) {
        return Response.json({ error: "Team analytics input is not revisioned or has mismatched identity" }, { status: 409 });
      }
      return Response.json({
        contract_version: 1,
        team_key: this.teamKey,
        team_source_revision: revision,
        team_state: teamState,
      }, {
        headers: {
          "X-FieldView-Team-Source-Revision": String(revision),
          "Cache-Control": "no-store",
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const states = await this.storage.list<TeamEndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      const providerByEndpoint = new Map(this.endpoints(year).map((resource) => [resource.endpoint, resource.provider] as const));
      const snapshotRevision = await this.storage.get<number>("snapshot-revision") ?? 0;
      return Response.json({ team_key: this.teamKey, snapshot_revision: snapshotRevision,
        readiness: {
          hydration: this.hydrationMode === "platform-barrier" ? "complete" : "storage-backed",
          hydrated_scope: ["team_identity", "team_state_publications"],
          publications: [...this.publishedSnapshots.entries()].map(([year, publication]) => ({
            year, exists: true, input_signature: publication.input_signature,
            snapshot_revision: snapshotRevision,
          })),
          polling_owner: "PollingCoordinatorWorkflow",
          local_poll_tasks: 0,
          last_error: [...states.values()].find((state) => state.lastError)?.lastError ?? null,
        },
        active_events: Object.keys(await this.storage.get<Record<string, ActiveEventMembership>>(ACTIVE_EVENTS_KEY) ?? {}).sort(),
        polling: [],
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
    // TeamRuntime cannot query EventRuntime during a season read. The analytics
    // Workflow owns cross-runtime freshness and writes versioned TeamEventState
    // results here; local revisions invalidate this aggregate when those results change.
    const cacheKey = "team-season-analytics:" + year;
    const cached = await this.storage.get<{
      team_source_revision: number;
      event_revisions: Record<string, number>;
      response: Record<string, unknown>;
    }>(cacheKey);
    if (cached && cached.team_source_revision === teamSourceRevision &&
        JSON.stringify(cached.event_revisions) === JSON.stringify(eventRevisions)) {
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
      const inputs = await this.storage.get<{
        team_source_revision: number;
        event_source_revision: number;
        comparison_input_updated_at: number;
        publication_status?: "pending" | "published";
      }>(TEAM_EVENT_STATE_PREFIX + event.key + ":inputs");
      const current = Boolean(eventState?.analytics &&
        inputs?.publication_status !== "pending" &&
        inputs?.team_source_revision === teamSourceRevision &&
        Number.isSafeInteger(inputs?.event_source_revision) && (inputs?.event_source_revision ?? -1) >= 0 &&
        Number.isSafeInteger(inputs?.comparison_input_updated_at) && (inputs?.comparison_input_updated_at ?? -1) >= 0);
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
    if (result.status === "not-modified") {
      const latest = await this.storage.get<TeamEndpointState<unknown>>(endpointKey(resource.endpoint)) ?? initial;
      return {
        success: latest.lastFetchedAt !== null,
        status: latest.status,
        revision: latest.revision,
        last_fetched_at: latest.lastFetchedAt,
        http_status: latest.lastHttpStatus ?? null,
        last_error: latest.lastError ?? null,
      };
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


}
