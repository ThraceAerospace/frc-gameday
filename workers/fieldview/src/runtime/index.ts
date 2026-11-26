import { EventRuntime } from "./event-runtime.ts";
import { Multiplexer } from "./multiplexer.ts";
import { TeamRuntime } from "./team-runtime.ts";
import { DiscoveryService } from "./discovery-service.ts";
import type { RuntimeEnvironment } from "./cloudflare.ts";
import { verifyTbaWebhookHmac } from "./webhook-auth.ts";
import { normalizeFieldViewEvent } from "../../../../packages/domain/src/normalization/event.ts";
import { dispatchRuntimeRefresh, dispatchRuntimeRefreshBatch, type RuntimeRefreshTarget } from "./runtime-refresh.ts";

export { EventRuntime, Multiplexer, TeamRuntime };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface DiscoveryRecord { json<T>(): Promise<T>; text(): Promise<string>; }
interface DiscoveryServiceClient {
  get(key: string): Promise<DiscoveryRecord | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
}
function discoveryServiceClient(env: RuntimeEnvironment): DiscoveryServiceClient {
  const storage = env.DISCOVERY_STORAGE ?? env.DB;
  if (!storage) return {
    async get() { return null; }, async put() {}, async list() { return { objects: [], truncated: false }; },
  };
  const service = new DiscoveryService(storage, env);
  return {
    async get(key) {
      const response = await service.fetch(new Request("https://discovery-service/get?key=" + encodeURIComponent(key)));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Discovery read returned HTTP " + response.status);
      const value = await response.text();
      return { async text() { return value; }, async json<T>() { return JSON.parse(value) as T; } };
    },
    async put(key, value) {
      const response = await service.fetch(new Request("https://discovery-service/put", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }) }));
      if (!response.ok) throw new Error("Discovery write returned HTTP " + response.status);
    },
    async list(options = {}) {
      const query = new URLSearchParams({ prefix: options.prefix ?? "", limit: String(options.limit ?? 1000) });
      if (options.cursor) query.set("cursor", options.cursor);
      const response = await service.fetch(new Request("https://discovery-service/list?" + query));
      if (!response.ok) throw new Error("Discovery list returned HTTP " + response.status);
      return await response.json() as { objects: Array<{ key: string }>; truncated: boolean; cursor?: string };
    },
  };
}

function jobsRequest(env: RuntimeEnvironment, request: Request): Promise<Response> {
  if (env.JOBS_REQUEST) return env.JOBS_REQUEST(request);
  return Promise.resolve(Response.json({ error: "Jobs module is unavailable" }, { status: 503 }));
}

function authorized(request: Request, env: RuntimeEnvironment): boolean {
  return Boolean(env.RUNTIME_ADMIN_TOKEN) &&
    request.headers.get("Authorization") === `Bearer ${env.RUNTIME_ADMIN_TOKEN}`;
}

async function registerRuntimeMarker(env: RuntimeEnvironment, kind: "event" | "team", key: string): Promise<boolean> {
  if (!env.DB && !env.DISCOVERY_STORAGE) return false;
  const prefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
  const markerKey = prefix + key + ".json";
  if (await discoveryServiceClient(env).get(markerKey)) return true;
  await discoveryServiceClient(env).put(markerKey, "{}", {
    httpMetadata: { contentType: "application/json" },
  });
  return true;
}

async function processTbaWebhook(rawBody: ArrayBuffer, env: RuntimeEnvironment): Promise<void> {

  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(rawBody)); }
  catch {
    console.warn("[WEBHOOK][TBA] Dropped webhook with invalid JSON");
    return;
  }
  if (!isRecord(payload) || typeof payload.message_type !== "string" || !isRecord(payload.message_data)) {
    console.warn("[WEBHOOK][TBA] Dropped webhook with invalid payload shape");
    return;
  }

  const messageData = payload.message_data;
  const webhookLog: Record<string, unknown> = { message_type: payload.message_type };
  if (typeof messageData.event_key === "string") webhookLog.event_key = messageData.event_key;
  if (payload.message_type === "verification") webhookLog.verification_key = messageData.verification_key ?? null;
  console.log("[WEBHOOK][TBA] Received", JSON.stringify(webhookLog));

  if (["ping", "verification", "broadcast"].includes(payload.message_type)) return;

  const eventData = messageData.event;
  const matchData = messageData.match;
  const eventKey = messageData.event_key ??
    (isRecord(eventData) ? eventData.key : undefined) ??
    (isRecord(matchData) ? matchData.event_key : undefined);
  if (typeof eventKey !== "string" || !/^[a-zA-Z0-9_-]+$/.test(eventKey)) {
    console.warn("[WEBHOOK][TBA] Dropped webhook without a valid event key", JSON.stringify({ message_type: payload.message_type }));
    return;
  }

  const messageType = payload.message_type;
  const teamKeys = new Set<string>();
  const addTeamKey = (value: unknown) => {
    if (typeof value === "string" && /^frc[0-9]+$/.test(value)) teamKeys.add(value);
  };
  const addMatchTeams = (value: unknown) => {
    if (!isRecord(value) || !isRecord(value.alliances)) return;
    for (const color of ["red", "blue"]) {
      const alliance = value.alliances[color];
      if (isRecord(alliance)) {
        const teams = Array.isArray(alliance.teams) ? alliance.teams : alliance.team_keys;
        if (Array.isArray(teams)) for (const key of teams) addTeamKey(key);
      }
    }
  };
  if (messageType === "match_score" || messageType === "match_video") {
    addMatchTeams(matchData);
    addTeamKey(messageData.team_key);
  } else if (messageType === "upcoming_match") {
    if (Array.isArray(messageData.team_keys)) for (const key of messageData.team_keys) addTeamKey(key);
    addTeamKey(messageData.team_key);
  } else if (!["awards_posted", "alliance_selection", "schedule_updated", "starting_comp_level"].includes(messageType)) {
    console.warn("[WEBHOOK][TBA] Ignoring unsupported webhook message type", JSON.stringify({ message_type: messageType, event_key: eventKey }));
    return;
  }

  if (!env.EVENT_RUNTIME) {
    console.error("[WEBHOOK][TBA] EventRuntime binding is unavailable", JSON.stringify({ event_key: eventKey }));
    return;
  }
  const digest = await crypto.subtle.digest("SHA-256", rawBody);
  const webhookId = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const headers = new Headers({
    Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN,
    "X-FieldView-Event-Key": eventKey,
    "X-FieldView-Webhook-Id": webhookId,
    "Content-Type": "application/json",
  });
  const targets: Array<{ kind: "event"; key: string; promise: Promise<Response> }> = [];
  try {
    const eventStub = env.EVENT_RUNTIME.get(env.EVENT_RUNTIME.idFromName(eventKey));
    targets.push({ kind: "event", key: eventKey, promise: eventStub.fetch(new Request("https://event-runtime/webhook", {
      method: "POST", headers: new Headers(headers), body: rawBody,
    })) });
  } catch (error) {
    console.error("[WEBHOOK][TBA] Failed to dispatch EventRuntime webhook", JSON.stringify({
      event_key: eventKey, webhook_id: webhookId, error: String(error),
    }));
    return;
  }

  const outcomes = await Promise.allSettled(targets.map((target) => target.promise));
  const failures: Array<{ kind: "event"; key: string; error?: string; status?: number }> = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      failures.push({ kind: targets[index].kind, key: targets[index].key, error: String(outcome.reason) });
    } else if (!outcome.value.ok) {
      failures.push({ kind: targets[index].kind, key: targets[index].key, status: outcome.value.status });
    }
  });
  if (failures.length > 0) {
    console.error("[WEBHOOK][TBA] EventRuntime webhook dispatch failed", JSON.stringify({
      event_key: eventKey, webhook_id: webhookId, target_count: targets.length, failures,
    }));
    return;
  }
  await registerRuntimeMarker(env, "event", eventKey);
  if (env.EVENT_ANALYTICS_WORKFLOW) {
    const affectedTeamKeys = ["match_score", "upcoming_match"].includes(messageType) && teamKeys.size > 0
      ? [...teamKeys].sort()
      : null;
    let workflowId = "tba-webhook-analytics-" + eventKey + "-" + webhookId.slice(0, 24);
    try {
      let shouldCreate = true;
      try {
        const existing = await env.EVENT_ANALYTICS_WORKFLOW.get(workflowId).then((instance) => instance.status());
        if (["queued", "running", "waiting", "waitingForPause", "paused", "complete"].includes(existing.status)) {
          shouldCreate = false;
        } else {
          workflowId += "-retry-" + Date.now();
        }
      } catch {
        // No workflow exists for this webhook identity.
      }
      if (shouldCreate) {
        await env.EVENT_ANALYTICS_WORKFLOW.create({
          id: workflowId,
          params: {
            event_key: eventKey,
            affected_team_keys: affectedTeamKeys,
            requested_at: Date.now(),
          },
        });
      }
    } catch (error) {
      console.error("[WEBHOOK][TBA] Failed to start event analytics Workflow", JSON.stringify({
        event_key: eventKey, webhook_id: webhookId, error: String(error),
      }));
    }
  }
  console.log("[WEBHOOK][TBA] EventRuntime accepted webhook; analytics Workflow dispatch completed", JSON.stringify({
    event_key: eventKey, webhook_id: webhookId,
  }));
}

export default {
  async fetch(request: Request, env: RuntimeEnvironment, context: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/polling/refresh" && request.method === "POST") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || typeof body.event_key !== "string" ||
          !/^[0-9]{4}[a-zA-Z0-9_-]+$/.test(body.event_key) ||
          !Array.isArray(body.team_keys) || body.team_keys.length > 12 ||
          !body.team_keys.every((key) => typeof key === "string" && /^frc[0-9]+$/.test(key)) ||
          (body.event_endpoints !== undefined &&
            (!Array.isArray(body.event_endpoints) || !body.event_endpoints.every((endpoint) => typeof endpoint === "string"))) ||
          (body.team_endpoints !== undefined && !isRecord(body.team_endpoints))) {
        return Response.json({ error: "Expected an event_key, up to 12 valid team_keys, and optional endpoint lists" }, { status: 400 });
      }
      if (isRecord(body.team_endpoints)) {
        const targetKeys = new Set(body.team_keys as string[]);
        for (const [teamKey, endpoints] of Object.entries(body.team_endpoints)) {
          if (!targetKeys.has(teamKey) || !Array.isArray(endpoints) ||
              !endpoints.every((endpoint) => typeof endpoint === "string")) {
            return Response.json({ error: "team_endpoints must contain string arrays for requested team_keys only" }, { status: 400 });
          }
        }
      }
      const eventKey = body.event_key;
      const year = Number(eventKey.slice(0, 4));
      const eventTarget: RuntimeRefreshTarget = {
        kind: "event", key: eventKey, year,
        ...(Array.isArray(body.event_endpoints) &&
          body.event_endpoints.every((endpoint) => typeof endpoint === "string")
          ? { endpoints: body.event_endpoints as string[] } : {}),
      };
      const eventOutcome = await dispatchRuntimeRefresh(env, eventTarget);
      if (!eventOutcome.ok) {
        return Response.json({
          event: eventOutcome,
          teams: [],
          stopped_after_event_failure: true,
        }, { status: 502 });
      }
      const teamTargets: RuntimeRefreshTarget[] = [...new Set(body.team_keys as string[])].map((key) => ({
        kind: "team",
        key,
        year,
        ...(isRecord(body.team_endpoints) && Array.isArray(body.team_endpoints[key]) &&
          (body.team_endpoints[key] as unknown[]).every((endpoint) => typeof endpoint === "string")
          ? { endpoints: body.team_endpoints[key] as string[] } : {}),
      }));
      const teamOutcomes = await dispatchRuntimeRefreshBatch(env, teamTargets, 4);
      let analyticsWorkflowId: string | undefined;
      if (teamTargets.length === 0 && env.EVENT_ANALYTICS_WORKFLOW &&
          isRecord(eventOutcome.response) && "affected_team_keys" in eventOutcome.response) {
        const affected = eventOutcome.response.affected_team_keys;
        if (affected === null || (Array.isArray(affected) && affected.length > 0 &&
            affected.every((key) => typeof key === "string" && /^frc[0-9]+$/.test(key)))) {
          analyticsWorkflowId = "manual-event-analytics-" + eventKey + "-" + Date.now();
          await env.EVENT_ANALYTICS_WORKFLOW.create({
            id: analyticsWorkflowId,
            params: {
              event_key: eventKey,
              affected_team_keys: affected as string[] | null,
              requested_at: Date.now(),
            },
          });
        }
      }
      return Response.json({
        event: eventOutcome,
        ...(analyticsWorkflowId ? { analytics_workflow_id: analyticsWorkflowId } : {}),
        teams: teamOutcomes,
        team_refreshes_succeeded: teamOutcomes.filter((outcome) => outcome.ok).length,
        team_refreshes_failed: teamOutcomes.filter((outcome) => !outcome.ok).length,
      }, {
        status: teamOutcomes.some((outcome) => !outcome.ok) ? 207 : 200,
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (url.pathname.startsWith("/internal/discovery/")) {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (!env.DB) return Response.json({ error: "Discovery storage is unavailable" }, { status: 503 });
      const action = url.pathname.slice("/internal/discovery/".length);
      return new DiscoveryService(env.DISCOVERY_STORAGE ?? env.DB!, env).fetch(new Request("https://discovery-service/" + action + url.search, {
        method: request.method, headers: request.headers,
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.clone().arrayBuffer() }),
      }));
    }
    if (url.pathname === "/webhooks/tba" && request.method === "POST") {
      // Preserve the established ingress/authentication responses. Only an
      // authenticated webhook is acknowledged immediately and dispatched later.
      const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
      if (declaredLength > 1_000_000) {
        return Response.json({ error: "Webhook payload too large" }, { status: 413 });
      }
      const rawBody = await request.arrayBuffer();
      if (rawBody.byteLength > 1_000_000) {
        return Response.json({ error: "Webhook payload too large" }, { status: 413 });
      }

      const signature = request.headers.get("X-TBA-HMAC");
      if (!signature) return new Response("I'm a teapot", { status: 418 });
      if (!env.TBA_WEBHOOK_SECRET) {
        console.error("[WEBHOOK][TBA] TBA_WEBHOOK_SECRET is not configured");
        return new Response("Internal Server Error", { status: 500 });
      }
      if (!(await verifyTbaWebhookHmac(env.TBA_WEBHOOK_SECRET, signature, rawBody))) {
        return new Response("Unauthorized", { status: 401 });
      }

      context.waitUntil(Promise.resolve().then(() => processTbaWebhook(rawBody, env)).catch((error) => {
        console.error("[WEBHOOK][TBA] Unhandled background processing failure", String(error));
      }));
      return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    if (url.pathname === "/internal/admin/discover-year" && request.method === "GET") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (!env.JOBS_REQUEST) return Response.json({ error: "Jobs module is unavailable" }, { status: 503 });
      return jobsRequest(env, new Request("https://runtime-workflows/internal/admin/discover-year" + url.search, {
        method: "GET",
        headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN },
      }));
    }

    if (url.pathname === "/internal/admin/workflow-runs" && request.method === "GET") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (!env.JOBS_REQUEST) return Response.json({ error: "Jobs module is unavailable" }, { status: 503 });
      return jobsRequest(env, new Request("https://runtime-workflows/internal/admin/workflow-runs" + url.search, {
        method: "GET", headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN },
      }));
    }

    if (url.pathname === "/internal/admin/events-this-week/refresh" &&
        (request.method === "GET" || request.method === "POST")) {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (!env.JOBS_REQUEST) return Response.json({ error: "Jobs module is unavailable" }, { status: 503 });
      return jobsRequest(env, new Request("https://runtime-workflows/internal/admin/events-this-week/refresh" + url.search, {
        method: request.method,
        headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN },
      }));
    }

    if (url.pathname === "/internal/admin/daily-event-readiness" && request.method === "POST") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (!env.JOBS_REQUEST) return Response.json({ error: "Jobs module is unavailable" }, { status: 503 });
      return jobsRequest(env, new Request("https://runtime-workflows/internal/admin/daily-event-readiness", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN },
      }));
    }

    if (url.pathname === "/internal/admin/daily-team-readiness" && request.method === "POST") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (!env.JOBS_REQUEST) return Response.json({ error: "Jobs module is unavailable" }, { status: 503 });
      return jobsRequest(env, new Request("https://runtime-workflows/internal/admin/daily-team-readiness", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN },
      }));
    }

    if (url.pathname === "/internal/admin/event-readiness" && request.method === "POST") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || typeof body.event_key !== "string" ||
          !/^[a-zA-Z0-9_-]+$/.test(body.event_key) ||
          typeof body.year !== "number" || !Number.isSafeInteger(body.year) ||
          body.year < 1992 || body.year > 2200) {
        return Response.json({ error: "Expected a valid event_key and explicit season year" }, { status: 400 });
      }
      if (!env.DB && !env.DISCOVERY_STORAGE) {
        return Response.json({ error: "Discovery storage is unavailable" }, { status: 503 });
      }
      const year = body.year;
      const eventKey = body.event_key;
      const directoryObject = await discoveryServiceClient(env).get(`discovery/events/${year}.json`);
      if (!directoryObject) {
        return Response.json({ error: "No published event directory exists for the requested year" }, { status: 404 });
      }
      const directory = await directoryObject.json<unknown>().catch(() => null);
      if (!isRecord(directory) || directory.year !== year || !Array.isArray(directory.events)) {
        return Response.json({ error: "Published event directory is invalid" }, { status: 500 });
      }
      const discovered = directory.events.some((event) => isRecord(event) && event.key === eventKey);
      if (!discovered) {
        return Response.json({ error: "Event is not present in the published directory for the requested year" }, { status: 404 });
      }
      if (!env.EVENT_RUNTIME) {
        return Response.json({ error: "EventRuntime binding is unavailable" }, { status: 503 });
      }

      // Keep this operation deliberately narrow: one directory-verified event,
      // with its refresh alarm randomized inside the same five-minute window
      // used by the sequential daily readiness sweep.
      const refreshAt = Date.now() + Math.floor(Math.random() * 5 * 60_000);
      const stub = env.EVENT_RUNTIME.get(env.EVENT_RUNTIME.idFromName(eventKey));
      const response = await stub.fetch(new Request("https://event-runtime/readiness", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN,
          "X-FieldView-Event-Key": eventKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ refreshAt }),
      }));
      if (response.ok) await registerRuntimeMarker(env, "event", eventKey);
      return response;
    }

    if (url.pathname === "/internal/workflows/runtime-state" && request.method === "GET") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const kind = url.searchParams.get("kind");
      const key = url.searchParams.get("key") ?? "";
      if (!/^[a-zA-Z0-9_-]+$/.test(key) || (kind !== "event" && kind !== "team")) {
        return Response.json({ error: "Expected a valid runtime kind and entity key" }, { status: 400 });
      }
      if (kind === "event") {
        if (!env.EVENT_RUNTIME) return Response.json({ error: "EventRuntime binding is unavailable" }, { status: 503 });
        const stub = env.EVENT_RUNTIME.get(env.EVENT_RUNTIME.idFromName(key));
        return stub.fetch(new Request("https://event-runtime/state", {
          headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Event-Key": key },
        }));
      }
      if (!env.TEAM_RUNTIME) return Response.json({ error: "TeamRuntime binding is unavailable" }, { status: 503 });
      const teamKey = /^\d+$/.test(key) ? "frc" + key : key;
      const stub = env.TEAM_RUNTIME.get(env.TEAM_RUNTIME.idFromName(teamKey));
      return stub.fetch(new Request("https://team-runtime/state", {
        headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Team-Key": teamKey },
      }));
    }

    if (url.pathname === "/season/current" && request.method === "GET") {
      if (!env.DB && !env.DISCOVERY_STORAGE) {
        return Response.json({ error: "Discovery storage is unavailable" }, { status: 503 });
      }
      const object = await discoveryServiceClient(env).get("discovery/current-season.json");
      if (!object) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      const current = await object.json<{ year?: unknown; checkedAt?: unknown }>().catch(() => null);
      if (!current || !Number.isInteger(current.year) || Number(current.year) < 1992 ||
          Number(current.year) > 2200 || !Number.isFinite(current.checkedAt)) {
        return Response.json({ error: "Published current-season record is invalid" }, { status: 500 });
      }
      return Response.json({ year: current.year, checkedAt: current.checkedAt }, {
        headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
      });
    }

    if (url.pathname === "/events/this-week" && request.method === "GET") {
      if (!env.DB && !env.DISCOVERY_STORAGE) {
        return Response.json({ error: "Discovery storage is unavailable" }, { status: 503 });
      }
      const object = await discoveryServiceClient(env).get("projections/events-this-week/current.json");
      if (object) {
        const projection = await object.json<{
          schemaVersion: number; year: number; evaluatedAt: number; runDate: string;
          weekStart: string; checkedAt: number; events: Array<Record<string, unknown>>;
        }>();
        if (projection.schemaVersion === 1 && Number.isInteger(projection.year) &&
            Number.isFinite(projection.evaluatedAt) && Number.isFinite(projection.checkedAt) &&
            Array.isArray(projection.events)) {
          const now = new Date(Date.now() - 16 * 60 * 60_000);
          const weekday = now.getUTCDay();
          now.setUTCHours(0, 0, 0, 0);
          now.setUTCDate(now.getUTCDate() - ((weekday + 6) % 7));
          const currentWeekStart = now.toISOString().slice(0, 10);
          const stale = projection.weekStart !== currentWeekStart;
          const events = projection.events.filter((event) => event && typeof event.key === "string")
            .sort((a, b) => String(a.key).localeCompare(String(b.key)));
          return Response.json({
            evaluatedAt: projection.evaluatedAt,
            runDate: projection.runDate,
            checkedAt: projection.checkedAt,
            weekStart: projection.weekStart,
            events: events.map((event) => normalizeFieldViewEvent(event as never, {
              tba_event: {
                status: stale ? "stale" : "available",
                retrieved_at: new Date(projection.checkedAt).toISOString(),
              },
            })),
            index: { status: stale ? "stale" : "available", persisted: true },
          }, { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } });
        }
      }
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/events/discovery" && request.method === "GET") {
      const requestedYear = Number(url.searchParams.get("year"));
      if (!Number.isSafeInteger(requestedYear) || requestedYear < 1992 || requestedYear > 2200) {
        return Response.json({ error: "Invalid discovery year" }, { status: 400 });
      }
      if (!env.DB && !env.DISCOVERY_STORAGE) {
        return Response.json({ error: "Discovery storage is unavailable" }, { status: 503 });
      }
      const object = await discoveryServiceClient(env).get("discovery/events/" + requestedYear + ".json");
        if (object) {
          const discovery = await object.json<{
            year: number; events: Array<Record<string, unknown>>;
            updatedAt: number; checkedAt: number; etag: string | null;
          }>();
          const stale = Date.now() - discovery.checkedAt > 36 * 60 * 60_000;
          const retrievedAt = new Date(discovery.updatedAt).toISOString();
          return Response.json({
            year: discovery.year,
            events: discovery.events.map((event) => normalizeFieldViewEvent(event as never, {
              tba_event: {
                status: stale ? "stale" : "available",
                retrieved_at: retrievedAt,
                ...(discovery.etag === null ? {} : { validator: discovery.etag }),
              },
            })),
            updatedAt: discovery.updatedAt,
            checkedAt: discovery.checkedAt,
            index: { status: stale ? "stale" : "available", persisted: true, last_error: null },
            revalidation: stale ? "workflow_managed" : "idle",
          }, {
            headers: {
              "Cache-Control": "public, max-age=300, stale-while-revalidate=300",
              ...(discovery.etag === null ? {} : { ETag: discovery.etag }),
            },
          });
        }
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/teams/discovery" && request.method === "GET") {
      const year = Number(url.searchParams.get("year"));
      if (!Number.isSafeInteger(year) || year < 1992 || year > 2200) {
        return Response.json({ error: "Invalid team discovery year" }, { status: 400 });
      }
      if (!env.DB && !env.DISCOVERY_STORAGE) {
        return Response.json({ error: "Discovery storage is unavailable" }, { status: 503 });
      }
      const manifestObject = await discoveryServiceClient(env).get(`discovery/teams/${year}.json`);
      if (!manifestObject) {
        return Response.json({ error: "Team discovery is not published for the requested season" }, {
          status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" },
        });
      }
      const manifest = await manifestObject.json<{
        year: number; generation: number; pageCount: number; teamCount: number; updatedAt: number; checkedAt: number;
      }>();
      if (manifest.year !== year || !Number.isSafeInteger(manifest.pageCount) || manifest.pageCount < 1) {
        return Response.json({ error: "Published team discovery manifest is invalid" }, { status: 503 });
      }
      const teamKeys: string[] = [];
      for (let page = 0; page < manifest.pageCount; page += 1) {
        const pageObject = await discoveryServiceClient(env).get(
          `discovery/team-pages/${year}/${manifest.generation}/${page}.json`,
        );
        if (!pageObject) return Response.json({ error: `Team discovery page ${page} is missing` }, { status: 503 });
        const pageTeamKeys = await pageObject.json<unknown>();
        if (!Array.isArray(pageTeamKeys) ||
            pageTeamKeys.some((key) => typeof key !== "string" || !/^frc[0-9]+$/.test(key))) {
          return Response.json({ error: `Team discovery page ${page} is invalid` }, { status: 503 });
        }
        teamKeys.push(...pageTeamKeys);
      }
      if (teamKeys.length !== manifest.teamCount) {
        return Response.json({ error: "Published team discovery count does not match its pages" }, { status: 503 });
      }
      return Response.json({
        year,
        team_keys: teamKeys,
        team_count: teamKeys.length,
        updatedAt: manifest.updatedAt,
        checkedAt: manifest.checkedAt,
      }, { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=300" } });
    }

    if (url.pathname === "/internal/admin/operations" && request.method === "POST") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || typeof body.kind !== "string" || typeof body.action !== "string") {
        return Response.json({ error: "Expected kind and action" }, { status: 400 });
      }
      const { kind, action } = body;
      if (kind === "system") {
        if (action === "discover-year") {
          const year = Number(body.year);
          if (!Number.isInteger(year) || year < 1992 || year > 2200) {
            return Response.json({ error: "A valid discovery year is required" }, { status: 400 });
          }
          if (!env.JOBS_REQUEST) return Response.json({ error: "Jobs module is unavailable" }, { status: 503 });
          return jobsRequest(env, new Request("https://runtime-workflows/internal/admin/discover-year", {
            method: "POST",
            headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ year }),
          }));
        }
        if (action === "coverage-audit-start" || action === "coverage-audit-continue" || action === "coverage-audit-pause") {
          const year = Number(body.year);
          if (!Number.isInteger(year) || year < 1992 || year > 2200) return Response.json({ error: "A valid audit year is required" }, { status: 400 });
          if (!env.JOBS_REQUEST) return Response.json({ error: "Jobs module is unavailable" }, { status: 503 });
          return jobsRequest(env, new Request("https://runtime-workflows/internal/admin/coverage-audit", {
            method: "POST",
            headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ action: action === "coverage-audit-start" ? "start" : action === "coverage-audit-pause" ? "pause" : "continue", year }),
          }));
        }
        if (!["season-ingest-preview", "season-ingest-start", "season-ingest-pause", "season-ingest-resume", "season-ingest-cancel"].includes(action)) {
          return Response.json({ error: "Unsupported system operation" }, { status: 400 });
        }
        const year = Number(body.year);
        if (!Number.isInteger(year) || year < 1992 || year > 2200) return Response.json({ error: "A valid season-ingest year is required" }, { status: 400 });
        if (!env.JOBS_REQUEST) return Response.json({ error: "Jobs module is unavailable" }, { status: 503 });
        const operation = action === "season-ingest-preview" ? "preview" : action.slice("season-ingest-".length);
        return jobsRequest(env, new Request("https://runtime-workflows/internal/admin/runtime-job", {
          method: "POST", headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ operation: "season-ingest", action: operation, year, confirm: body.confirm === true }),
        }));
      }
      if (typeof body.key !== "string" || !/^[a-zA-Z0-9_-]+$/.test(body.key)) {
        return Response.json({ error: "A valid event or team key is required" }, { status: 400 });
      }
      const key = body.key;
      if (kind === "event") {
        if (!["refresh", "recalculate", "statbotics-refresh", "resource-refresh", "seed-event-teams"].includes(action)) {
          return Response.json({ error: "Unsupported event operation" }, { status: 400 });
        }
        if (action === "seed-event-teams") {
          const year = body.year === undefined ? Number(key.slice(0, 4)) : Number(body.year);
          if (!Number.isInteger(year) || year < 1992 || year > 2200) return Response.json({ error: "Invalid event season year" }, { status: 400 });
          if (!env.JOBS_REQUEST) return Response.json({ error: "Jobs module is unavailable" }, { status: 503 });
          return jobsRequest(env, new Request("https://runtime-workflows/internal/admin/runtime-job", {
            method: "POST", headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ operation: "event-team-seed", action: "start", event_key: key, year }),
          }));
        }
        const stub = env.EVENT_RUNTIME.get(env.EVENT_RUNTIME.idFromName(key));
        const headers = {
          Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN,
          "X-FieldView-Event-Key": key,
          "Content-Type": "application/json",
        };
        const endpoint = body.endpoint;
        if (action === "resource-refresh" && typeof endpoint !== "string") {
          return Response.json({ error: "A resource endpoint is required" }, { status: 400 });
        }
        const path = action === "statbotics-refresh" || (action === "resource-refresh" && typeof endpoint === "string" && endpoint.startsWith("/matches?event=")) ? "statbotics-refresh" : action === "recalculate" ? "recalculate" : "refresh";
        const payload = action === "resource-refresh" ? { endpoints: [endpoint], includeStatbotics: false } : {};
        const response = await stub.fetch(new Request("https://event-runtime/" + path, {
          method: "POST", headers, body: JSON.stringify(payload),
        }));
        if (response.ok) await registerRuntimeMarker(env, "event", key);
        return response;
      }
      if (kind === "team") {
        if (!["refresh", "seed"].includes(action)) return Response.json({ error: "Unsupported team operation" }, { status: 400 });
        if (!env.TEAM_RUNTIME) return Response.json({ error: "Team runtime is not bound" }, { status: 503 });
        const year = body.year === undefined ? new Date().getUTCFullYear() : Number(body.year);
        if (!Number.isInteger(year) || year < 1992 || year > new Date().getUTCFullYear() + 1) {
          return Response.json({ error: "Invalid season year" }, { status: 400 });
        }
        const teamKey = /^\d+$/.test(key) ? "frc" + key : key;
        if (action === "seed") {
          if (!env.JOBS_REQUEST) return Response.json({ error: "Jobs module is unavailable" }, { status: 503 });
          return jobsRequest(env, new Request("https://runtime-workflows/internal/admin/runtime-job", {
            method: "POST", headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ operation: "team-seed", action: "start", team_key: teamKey, year }),
          }));
        }
        const stub = env.TEAM_RUNTIME.get(env.TEAM_RUNTIME.idFromName(teamKey));
        const response = await stub.fetch(new Request("https://team-runtime/refresh?year=" + year, {
          method: "POST",
          headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Team-Key": teamKey },
        }));
        if (response.ok) await registerRuntimeMarker(env, "team", teamKey);
        return response;
      }
      return Response.json({ error: "Unsupported operation kind" }, { status: 400 });
    }

    if (url.pathname === "/internal/workflows/dispatch" && request.method === "POST") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || (body.kind !== "team" && body.kind !== "event") ||
          typeof body.key !== "string" || typeof body.action !== "string") {
        return Response.json({ error: "Invalid runtime dispatch request" }, { status: 400 });
      }
      const { kind, key, action } = body;
      if (kind === "team" && !/^frc\d+$/.test(key)) return Response.json({ error: "Invalid team key" }, { status: 400 });
      if (kind === "event" && !/^[a-zA-Z0-9_-]+$/.test(key)) return Response.json({ error: "Invalid event key" }, { status: 400 });
      const year = Number(body.year);
      if (!Number.isInteger(year) || year < 1992 || year > 2200) return Response.json({ error: "Invalid season year" }, { status: 400 });
      const headers = {
        Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN,
        ...(kind === "team" ? { "X-FieldView-Team-Key": key } : { "X-FieldView-Event-Key": key }),
        "Content-Type": "application/json",
      };
      if (kind === "event" && action === "register") {
        if (!env.EVENT_RUNTIME) return Response.json({ error: "EventRuntime is unavailable" }, { status: 503 });
        const stub = env.EVENT_RUNTIME.get(env.EVENT_RUNTIME.idFromName(key));
        const response = await stub.fetch(new Request("https://event-runtime/register", {
          method: "POST", headers,
        }));
        if (response.ok && !(await registerRuntimeMarker(env, "event", key))) {
          return Response.json({ error: "Runtime registry storage is unavailable" }, { status: 503 });
        }
        return response;
      }
      if (kind === "team") {
        if (!env.TEAM_RUNTIME) return Response.json({ error: "TeamRuntime is unavailable" }, { status: 503 });
        const stub = env.TEAM_RUNTIME.get(env.TEAM_RUNTIME.idFromName(key));
        const path = action === "seed" ? "seed?year=" + year
          : action === "state" ? "state?year=" + year
          : action === "snapshot" ? "snapshot?year=" + year + "&noSchedule=1" : null;
        if (!path) return Response.json({ error: "Unsupported team runtime dispatch" }, { status: 400 });
        const response = await stub.fetch(new Request("https://team-runtime/" + path, {
          method: action === "state" || action === "snapshot" ? "GET" : "POST", headers,
        }));
        if (response.ok) await registerRuntimeMarker(env, "team", key);
        return response;
      }
      if (!env.EVENT_RUNTIME) return Response.json({ error: "EventRuntime is unavailable" }, { status: 503 });
      const stub = env.EVENT_RUNTIME.get(env.EVENT_RUNTIME.idFromName(key));
      const allowed: Record<string, string> = {
        participants: "participants", state: "state", refresh: "refresh",
        publish: "publish-state", recalculate: "recalculate", analytics: "analytics",
      };
      const path = allowed[action];
      if (!path) return Response.json({ error: "Unsupported event runtime dispatch" }, { status: 400 });
      const method = action === "state" || action === "analytics" ? "GET" : "POST";
      const payload = { ...body };
      delete payload.kind; delete payload.key; delete payload.action; delete payload.year;
      const response = await stub.fetch(new Request("https://event-runtime/" + path, {
        method, headers,
        ...(method === "GET" ? {} : { body: JSON.stringify(payload) }),
      }));
      if (response.ok) await registerRuntimeMarker(env, "event", key);
      return response;
    }

    if (url.pathname === "/internal/admin/coverage-audit" && (request.method === "GET" || request.method === "POST")) {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (!env.JOBS_REQUEST) return Response.json({ error: "Jobs module is unavailable" }, { status: 503 });
      return jobsRequest(env, new Request("https://runtime-workflows/internal/admin/coverage-audit" + url.search, {
        method: request.method,
        headers: {
          Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN,
          ...(request.method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(request.method === "POST" ? { body: await request.clone().arrayBuffer() } : {}),
      }));
    }

    if (url.pathname === "/internal/admin/discovery-job" && request.method === "GET") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (!env.JOBS_REQUEST) return Response.json({ error: "Jobs module is unavailable" }, { status: 503 });
      return jobsRequest(env, new Request("https://runtime-workflows/internal/admin/discovery-job" + url.search, {
        headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN },
      }));
    }

    if (url.pathname === "/internal/admin/inventory" && request.method === "GET") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const kind = url.searchParams.get("kind");
      const year = Number(url.searchParams.get("year") ?? new Date().getUTCFullYear());
      const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const cursor = Number(url.searchParams.get("cursor") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      if ((kind !== "event" && kind !== "team") || !Number.isInteger(year) || year < 1992 || year > 2200 ||
          !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return Response.json({ error: "Invalid inventory query" }, { status: 400 });
      }
      const discoveryKey = kind === "event" ? `discovery/events/${year}.json` : `registry/teams/${year}.json`;
      const discoveryObject = await discoveryServiceClient(env)?.get(discoveryKey);
      let discovered: string[] = [];
      if (discoveryObject) {
        try {
          const data = await discoveryObject.json<unknown>();
          discovered = kind === "event" && isRecord(data) && Array.isArray(data.events)
            ? data.events.map((item) => isRecord(item) ? item.key : null).filter((key): key is string => typeof key === "string")
            : Array.isArray(data) ? data.filter((key): key is string => typeof key === "string") : [];
        } catch { discovered = []; }
      }
      const prefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
      const runtimeKeys: string[] = [];
      if (env.DB) {
        let cursorToken: string | undefined;
        do {
          const page = await discoveryServiceClient(env).list({ prefix, limit: 1000, ...(cursorToken ? { cursor: cursorToken } : {}) });
          for (const object of page.objects) {
            const key = object.key.slice(prefix.length).replace(/\.json$/, "");
            if (key && (kind === "team" || key.startsWith(String(year)))) runtimeKeys.push(key);
          }
          cursorToken = page.truncated ? page.cursor : undefined;
        } while (cursorToken);
      }
      const keys = [...new Set([...discovered, ...runtimeKeys])].filter((key) => key.toLowerCase().includes(query)).sort();
      return Response.json({ kind, year, query, total: keys.length, cursor,
        discovery_ready: discovered.length > 0, next_cursor: cursor + limit < keys.length ? cursor + limit : null,
        keys: keys.slice(cursor, cursor + limit) }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/internal/admin/entity" && request.method === "GET") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const kind = url.searchParams.get("kind"), requestedKey = url.searchParams.get("key") ?? "";
      const year = Number(url.searchParams.get("year") ?? new Date().getUTCFullYear());
      if ((kind !== "event" && kind !== "team") || !/^[a-zA-Z0-9_-]+$/.test(requestedKey) ||
          !Number.isInteger(year) || year < 1992 || year > 2200) return Response.json({ error: "Invalid entity lookup" }, { status: 400 });
      const key = kind === "team" && /^\d+$/.test(requestedKey) ? "frc" + requestedKey : requestedKey;
      const directoryObject = await discoveryServiceClient(env)?.get(
        kind === "event" ? `discovery/events/${year}.json` : `registry/teams/${year}.json`,
      );
      let discovered = false;
      if (directoryObject) {
        try {
          const directory = await directoryObject.json<unknown>();
          discovered = kind === "event"
            ? isRecord(directory) && Array.isArray(directory.events) && directory.events.some((item) => isRecord(item) && item.key === key)
            : Array.isArray(directory) && directory.includes(key);
        } catch { discovered = false; }
      }
      const marker = await discoveryServiceClient(env)?.get(
        (kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/") + key + ".json",
      );
      if (!discovered && !marker) return Response.json({ error: "Entity is not registered or discovered for this season" }, { status: 404 });
      const namespace = kind === "event" ? env.EVENT_RUNTIME : env.TEAM_RUNTIME;
      if (!namespace) return Response.json({ error: kind + " runtime is unavailable" }, { status: 503 });
      const stub = namespace.get(namespace.idFromName(key));
      const headers = { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN,
        ...(kind === "event" ? { "X-FieldView-Event-Key": key } : { "X-FieldView-Team-Key": key }) };
      const response = await stub.fetch(new Request("https://" + kind + "-runtime/state?year=" + year, { headers }));
      return new Response(response.body, { status: response.status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } });
    }

    if (["/internal/admin/season-ingest", "/internal/admin/event-team-seed", "/internal/admin/team-seed"].includes(url.pathname) &&
        (request.method === "GET" || request.method === "POST")) {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (!env.JOBS_REQUEST) return Response.json({ error: "Jobs module is unavailable" }, { status: 503 });
      const operation = url.pathname.endsWith("season-ingest") ? "season-ingest"
        : url.pathname.endsWith("event-team-seed") ? "event-team-seed" : "team-seed";
      if (request.method === "GET") {
        const query = new URLSearchParams({ operation });
        for (const field of ["year", "team_key", "event_key"]) {
          const value = url.searchParams.get(field);
          if (value !== null) query.set(field, value);
        }
        return jobsRequest(env, new Request("https://runtime-workflows/internal/admin/runtime-job?" + query, {
          headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN },
        }));
      }
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body)) return Response.json({ error: "Invalid runtime job request" }, { status: 400 });
      return jobsRequest(env, new Request("https://runtime-workflows/internal/admin/runtime-job", {
        method: "POST", headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, operation }),
      }));
    }

    if (url.pathname === "/internal/admin/overview" && request.method === "GET") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const object = await discoveryServiceClient(env)?.get("discovery/current-season.json");
      const current = object ? await object.json<{ year: number }>().catch(() => null) : null;
      const year = current?.year ?? null;
      const eventObject = year === null ? null : await discoveryServiceClient(env)?.get(`discovery/events/${year}.json`);
      const teamObject = year === null ? null : await discoveryServiceClient(env)?.get(`discovery/teams/${year}.json`);
      const events = eventObject ? await eventObject.json<{ events?: unknown[]; updatedAt?: number; checkedAt?: number }>().catch(() => null) : null;
      const teams = teamObject ? await teamObject.json<{ teamCount?: number; updatedAt?: number }>().catch(() => null) : null;
      let multiplexer: unknown = null;
      if (env.MULTIPLEXER) {
        try {
          const stub = env.MULTIPLEXER.get(env.MULTIPLEXER.idFromName("shared"));
          const response = await stub.fetch(new Request("https://fieldview-multiplexer/state", {
            headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN },
          }));
          multiplexer = response.ok ? await response.json() : { status: response.status };
        } catch (error) { multiplexer = { error: error instanceof Error ? error.message : String(error) }; }
      }
      const runtimeKeys = async (kind: "event" | "team") => {
        if (!env.DB) return [] as string[];
        const prefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
        const keys: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await discoveryServiceClient(env).list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
          for (const item of page.objects) {
            const key = item.key.slice(prefix.length).replace(/\.json$/, "");
            if (key && (kind === "team" || key.startsWith(String(year)))) keys.push(key);
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return keys;
      };
      const eventRegistryObject = year === null ? null : await discoveryServiceClient(env)?.get(`registry/events/${year}.json`);
      const teamRegistryObject = year === null ? null : await discoveryServiceClient(env)?.get(`registry/teams/${year}.json`);
      const eventRegistry = eventRegistryObject ? await eventRegistryObject.json<string[]>().catch(() => []) : [];
      const teamRegistry = teamRegistryObject ? await teamRegistryObject.json<string[]>().catch(() => []) : [];
      const eventRuntimeKeys = await runtimeKeys("event");
      const teamRuntimeKeys = await runtimeKeys("team");
      return Response.json({
        generated_at: new Date().toISOString(),
        current_season: { year, status: !events ? "missing" :
          Date.now() - (events.checkedAt ?? events.updatedAt ?? 0) > 36 * 60 * 60_000 ? "stale" : "available",
          event_count: events?.events?.length ?? 0, team_count: teams?.teamCount ?? 0,
          updated_at: events?.updatedAt ?? null, checked_at: events?.checkedAt ?? null },
        events: [], teams: [], multiplexer, truncated: false,
        inventory: {
          events: new Set([...(eventRegistry ?? []), ...(events?.events ?? []).flatMap((item) =>
            isRecord(item) && typeof item.key === "string" ? [item.key] : []), ...eventRuntimeKeys]).size,
          teams: new Set([...(teamRegistry ?? []), ...teamRuntimeKeys]).size,
        },
      });
    }

    // District discovery is not implemented by the migrated runtime; do not route it through a retired global coordinator.
    // Team profiles are served by one lazy TeamRuntime per TBA team key.
    const teamParts = url.pathname.split("/");
    const teamKey = teamParts[2];
    const teamAction = teamParts[3];
    const validTeamRoute = teamParts.length === 4 && teamParts[1] === "teams" &&
      /^[a-zA-Z0-9_-]+$/.test(teamKey ?? "") &&
      (teamAction === "snapshot" || teamAction === "analytics");
    if (validTeamRoute && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      } });
    }
    if (validTeamRoute && request.method === "GET") {
      const canonicalTeamKey = /^\d+$/.test(teamKey) ? "frc" + teamKey : teamKey;
      if (teamAction === "analytics") {
        const year = url.searchParams.has("year") ? Number(url.searchParams.get("year")) : new Date().getUTCFullYear();
        if (!Number.isInteger(year) || year < 1992 || year > new Date().getUTCFullYear() + 1) {
          return Response.json({ error: "Invalid season year" }, { status: 400 });
        }
        const discovery = discoveryServiceClient(env);
        const runtimeMarker = discovery ? await discovery.get(`registry/runtime-teams/${canonicalTeamKey}.json`) : null;
        if (!runtimeMarker) return Response.json({ error: "Team state is not ready" }, { status: 404 });
        if (!env.TEAM_RUNTIME) return Response.json({ error: "Team runtime is not bound" }, { status: 503 });
        const stub = env.TEAM_RUNTIME.get(env.TEAM_RUNTIME.idFromName(canonicalTeamKey));
        const response = await stub.fetch(new Request("https://team-runtime/season-analytics?year=" + year, {
          method: "GET",
          headers: { "X-FieldView-Team-Key": canonicalTeamKey },
        }));
        const headers = new Headers(response.headers);
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Cache-Control", "no-store");
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }
      const discovery = discoveryServiceClient(env);
      const runtimeMarker = discovery ? await discovery.get(`registry/runtime-teams/${canonicalTeamKey}.json`) : null;
      if (!runtimeMarker) return Response.json({ error: "Team state is not ready" }, { status: 404 });
      if (!env.TEAM_RUNTIME) return Response.json({ error: "Team runtime is not bound" }, { status: 503 });
      // Public team snapshots must not mutate the global runtime registry.
      const stub = env.TEAM_RUNTIME.get(env.TEAM_RUNTIME.idFromName(canonicalTeamKey));
      const response = await stub.fetch(new Request("https://team-runtime/snapshot" + url.search, {
        method: "GET", headers: { "X-FieldView-Team-Key": canonicalTeamKey },
      }));
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Expose-Headers", "X-FieldView-Snapshot-Version");
      headers.set("Cache-Control", "no-store");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }

    const internalTeamParts = url.pathname.split("/");
    const requestedInternalTeamKey = internalTeamParts[3];
    // Keep numeric admin seed/refresh routes on the same Durable Object as
    // public frc-prefixed team snapshot routes.
    const internalTeamKey = /^\d+$/.test(requestedInternalTeamKey ?? "")
      ? "frc" + requestedInternalTeamKey
      : requestedInternalTeamKey;
    const internalTeamAction = internalTeamParts[4];
    const validInternalTeamRoute = internalTeamParts.length === 5 &&
      internalTeamParts[1] === "internal" && internalTeamParts[2] === "teams" &&
      /^[a-zA-Z0-9_-]+$/.test(internalTeamKey ?? "") &&
      ["state", "refresh", "seed"].includes(internalTeamAction ?? "");
    if (validInternalTeamRoute) {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (internalTeamAction === "seed" && request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      if (!env.TEAM_RUNTIME) return Response.json({ error: "Team runtime is not bound" }, { status: 503 });
      const stub = env.TEAM_RUNTIME.get(env.TEAM_RUNTIME.idFromName(internalTeamKey));
      const headers = new Headers(request.headers);
      headers.set("X-FieldView-Team-Key", internalTeamKey);
      return stub.fetch(new Request("https://team-runtime/" + internalTeamAction + url.search, {
        method: request.method, headers,
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.clone().arrayBuffer() }),
      }));
    }

    if (url.pathname === "/stream" && request.method === "GET" && env.MULTIPLEXER) {
      const stub = env.MULTIPLEXER.get(env.MULTIPLEXER.idFromName("shared"));
      return stub.fetch(new Request("https://fieldview-multiplexer/stream", { method: "GET", headers: request.headers }));
    }

    if (url.pathname === "/health") {
      return Response.json({ service: "fieldview", status: "ok" });
    }

    // Public event reads expose only canonical snapshots and read-only
    // revision notifications. No user account or browser-held service secret
    // is required; administrative and mutation routes remain private below.
    const publicParts = url.pathname.split("/");
    const publicEventKey = publicParts[2];
    const publicAction = publicParts[3];
    const validPublicRoute = publicParts.length === 4 &&
      publicParts[1] === "events" &&
      /^[a-zA-Z0-9_-]+$/.test(publicEventKey ?? "") &&
      (publicAction === "snapshot" || publicAction === "analytics" || publicAction === "statbotics-match" || publicAction === "stream");

    if (validPublicRoute && ["snapshot", "analytics", "statbotics-match"].includes(publicAction ?? "") && request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (validPublicRoute && request.method === "GET") {
      // A missing runtime marker means readiness has not created this entity.
      // Do not activate a Durable Object merely to answer a cold public read.
      const discovery = discoveryServiceClient(env);
      const runtimeMarker = discovery ? await discovery.get(`registry/runtime-events/${publicEventKey}.json`) : null;
      if (!runtimeMarker) return Response.json({ error: "Event state is not ready" }, { status: 404 });
      if (!env.EVENT_RUNTIME) return Response.json({ error: "EventRuntime is unavailable" }, { status: 503 });
      const stub = env.EVENT_RUNTIME.get(env.EVENT_RUNTIME.idFromName(publicEventKey));
      const headers = new Headers({
        "X-FieldView-Event-Key": publicEventKey,
      });
      if (publicAction === "stream") {
        const upgrade = request.headers.get("Upgrade");
        if (upgrade) headers.set("Upgrade", upgrade);
      }
      const forwarded = new Request(
        `https://event-runtime/${publicAction}${url.search}`,
        { method: "GET", headers },
      );
      const response = await stub.fetch(forwarded);
      if (publicAction === "stream") return response;

      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Expose-Headers", "X-FieldView-Snapshot-Version, X-FieldView-Analytics-Version");
      responseHeaders.set("Cache-Control", "no-store");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    const parts = url.pathname.split("/");
    const eventKey = parts[3];
    const action = parts[4];
    const validRoute = parts.length === 5 && parts[1] === "internal" &&
      parts[2] === "events" && /^[a-zA-Z0-9_-]+$/.test(eventKey ?? "") &&
      ["state", "snapshot", "stream", "refresh", "recalculate", "statbotics-refresh"].includes(action ?? "");
    if (!validRoute || !authorized(request, env)) {
      return Response.json({ error: "Not found" }, { status: validRoute ? 401 : 404 });
    }

    const id = env.EVENT_RUNTIME.idFromName(eventKey);
    const stub = env.EVENT_RUNTIME.get(id);
    const headers = new Headers(request.headers);
    headers.set("X-FieldView-Event-Key", eventKey);
    const forwarded = new Request(`https://event-runtime/${action}`, {
      method: request.method,
      headers,
      ...(request.method === "GET" || request.method === "HEAD"
        ? {}
        : { body: await request.clone().arrayBuffer() }),
    });
    return stub.fetch(forwarded);
  },

};
