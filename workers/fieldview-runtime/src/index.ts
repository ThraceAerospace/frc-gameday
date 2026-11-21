import { EventRuntime, eventResourceEndpoints } from "./event-runtime.ts";
import { classifyEventLifecycle, eventPollingPolicy } from "./task-scheduler.ts";
import { Multiplexer } from "./multiplexer.ts";
import { TaskScheduler } from "./task-scheduler.ts";
import { TeamRuntime } from "./team-runtime.ts";
import type { RuntimeEnvironment } from "./cloudflare.ts";
import { verifyTbaWebhookHmac } from "./webhook-auth.ts";

export { EventRuntime, TaskScheduler, Multiplexer, TeamRuntime };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authorized(request: Request, env: RuntimeEnvironment): boolean {
  return Boolean(env.RUNTIME_ADMIN_TOKEN) &&
    request.headers.get("Authorization") === `Bearer ${env.RUNTIME_ADMIN_TOKEN}`;
}

async function registerRuntimeObject(env: RuntimeEnvironment, kind: "event" | "team", key: string): Promise<void> {
  if (!env.TASK_SCHEDULER || !env.RUNTIME_ADMIN_TOKEN) return;
  const scheduler = env.TASK_SCHEDULER.get(env.TASK_SCHEDULER.idFromName("global"));
  await scheduler.fetch(new Request("https://task-scheduler/register", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ kind, key }),
  }));
}

export default {
  async fetch(request: Request, env: RuntimeEnvironment): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/webhooks/tba" && request.method === "POST") {
      const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
      if (declaredLength > 1_000_000) {
        return Response.json({ error: "Webhook payload too large" }, { status: 413 });
      }
      const rawBody = await request.arrayBuffer();
      if (rawBody.byteLength > 1_000_000) {
        return Response.json({ error: "Webhook payload too large" }, { status: 413 });
      }

      // Match the established Vercel webhook authentication contract:
      // a missing signature is a malformed request (418), while a supplied
      // but incorrect signature is unauthorized (401).
      const signature = request.headers.get("X-TBA-HMAC");
      if (!signature) {
        return new Response("I'm a teapot", { status: 418 });
      }
      if (!env.TBA_WEBHOOK_SECRET) {
        console.error("[WEBHOOK][TBA] TBA_WEBHOOK_SECRET is not configured");
        return new Response("Internal Server Error", { status: 500 });
      }
      if (!(await verifyTbaWebhookHmac(env.TBA_WEBHOOK_SECRET, signature, rawBody))) {
        return new Response("Unauthorized", { status: 401 });
      }

      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(rawBody)); }
      catch { return Response.json({ error: "Invalid webhook JSON" }, { status: 400 }); }
      if (!isRecord(payload) || typeof payload.message_type !== "string" ||
          !isRecord(payload.message_data)) {
        return Response.json({ error: "Invalid TBA webhook payload" }, { status: 400 });
      }

      // Log only useful, authenticated webhook metadata. The verification key
      // is intentionally included so it can be copied into the TBA dashboard;
      // never log the HMAC secret, signature, or complete payload.
      const webhookLog: Record<string, unknown> = {
        message_type: payload.message_type,
      };
      if (typeof payload.message_data.event_key === "string") {
        webhookLog.event_key = payload.message_data.event_key;
      }
      if (payload.message_type === "verification") {
        webhookLog.verification_key = payload.message_data.verification_key ?? null;
      }
      console.log("[WEBHOOK][TBA] Received", JSON.stringify(webhookLog));

      if (["ping", "verification", "broadcast"].includes(payload.message_type)) {
        return Response.json({ accepted: true });
      }
      const eventData = payload.message_data.event;
      const matchData = payload.message_data.match;
      const eventKey = payload.message_data.event_key ??
        (isRecord(eventData) ? eventData.key : undefined) ??
        (isRecord(matchData) ? matchData.event_key : undefined);
      if (typeof eventKey !== "string" || !/^[a-zA-Z0-9_-]+$/.test(eventKey)) {
        return Response.json({ error: "Webhook has no valid event key" }, { status: 400 });
      }

      const messageType = payload.message_type;
      const messageData = payload.message_data;
      const teamKeys = new Set<string>();
      const addTeamKey = (value: unknown) => {
        if (typeof value === "string" && /^frc[0-9]+$/.test(value)) teamKeys.add(value);
      };
      const addMatchTeams = (value: unknown) => {
        if (!isRecord(value) || !isRecord(value.alliances)) return;
        for (const color of ["red", "blue"]) {
          const alliance = value.alliances[color];
          if (isRecord(alliance) && Array.isArray(alliance.team_keys)) {
            for (const key of alliance.team_keys) addTeamKey(key);
          }
        }
      };
      if (messageType === "match_score" || messageType === "match_video") {
        addMatchTeams(matchData);
      } else if (messageType === "upcoming_match") {
        if (Array.isArray(messageData.team_keys)) {
          for (const key of messageData.team_keys) addTeamKey(key);
        }
        addTeamKey(messageData.team_key);
      } else if (messageType === "awards_posted") {
        if (Array.isArray(messageData.recipient_list)) {
          for (const recipient of messageData.recipient_list) {
            if (isRecord(recipient)) {
              if (typeof recipient.team_key === "string") addTeamKey(recipient.team_key);
              else if (typeof recipient.team_number === "number" && Number.isSafeInteger(recipient.team_number)) {
                addTeamKey("frc" + recipient.team_number);
              }
            }
          }
        }
        addTeamKey(messageData.team_key);
      } else if (messageType === "alliance_selection") {
        // TBA payload variants may include explicit selected team keys. Never
        // infer recipients from array positions or an event metadata object.
        const candidates = messageData.team_keys;
        if (Array.isArray(candidates)) for (const key of candidates) addTeamKey(key);
        addTeamKey(messageData.team_key);
      } else if (!["schedule_updated", "starting_comp_level"].includes(messageType)) {
        return Response.json({ error: "Unsupported TBA webhook message type" }, { status: 400 });
      }

      const digest = await crypto.subtle.digest("SHA-256", rawBody);
      const webhookId = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const headers = new Headers({
        Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN,
        "X-FieldView-Event-Key": eventKey,
        "X-FieldView-Webhook-Id": webhookId,
        "Content-Type": "application/json",
      });
      const targets: Array<{ kind: "event" | "team"; key: string; promise: Promise<Response> }> = [];
      const eventStub = env.EVENT_RUNTIME.get(env.EVENT_RUNTIME.idFromName(eventKey));
      targets.push({ kind: "event", key: eventKey, promise: eventStub.fetch(new Request("https://event-runtime/webhook", {
        method: "POST", headers: new Headers(headers), body: rawBody,
      })) });
      if (teamKeys.size > 0) {
        if (!env.TEAM_RUNTIME) return Response.json({ error: "TeamRuntime binding is required for this webhook scope" }, { status: 503 });
        for (const teamKey of teamKeys) {
          const teamStub = env.TEAM_RUNTIME.get(env.TEAM_RUNTIME.idFromName(teamKey));
          const teamHeaders = new Headers(headers);
          teamHeaders.set("X-FieldView-Team-Key", teamKey);
          targets.push({ kind: "team", key: teamKey, promise: teamStub.fetch(new Request("https://team-runtime/webhook", {
            method: "POST", headers: teamHeaders, body: rawBody,
          })) });
        }
      }
      const outcomes = await Promise.allSettled(targets.map((target) => target.promise));
      const failures = outcomes.flatMap((outcome, index) => {
        if (outcome.status === "rejected") return [{ kind: targets[index].kind, key: targets[index].key, error: String(outcome.reason) }];
        return outcome.value.ok ? [] : [{ kind: targets[index].kind, key: targets[index].key, status: outcome.value.status }];
      });
      if (failures.length > 0) {
        console.error("[WEBHOOK][TBA] Partial dispatch failure", JSON.stringify({ event_key: eventKey, webhook_id: webhookId, failures }));
        return Response.json({ accepted: false, event_key: eventKey, targets: targets.length, failures }, { status: 502 });
      }
      return Response.json({ accepted: true, event_key: eventKey, webhook_id: webhookId, targets: targets.map(({ kind, key }) => ({ kind, key })) });
    }

    if (url.pathname === "/events/this-week" && request.method === "GET") {
      if (!env.TASK_SCHEDULER) return Response.json({ error: "TaskScheduler is not bound" }, { status: 503 });
      const scheduler = env.TASK_SCHEDULER.get(env.TASK_SCHEDULER.idFromName("global"));
      return scheduler.fetch(new Request("https://task-scheduler/events/this-week"));
    }

    if (url.pathname === "/events/discovery" && request.method === "GET") {
      if (!env.TASK_SCHEDULER) return Response.json({ error: "TaskScheduler is not bound" }, { status: 503 });
      const scheduler = env.TASK_SCHEDULER.get(env.TASK_SCHEDULER.idFromName("global"));
      const query = new URLSearchParams();
      const year = url.searchParams.get("year");
      if (year !== null) query.set("year", year);
      return scheduler.fetch(new Request("https://task-scheduler/events?" + query.toString()));
    }

    if (url.pathname === "/teams/discovery" && request.method === "GET") {
      if (!env.TASK_SCHEDULER) return Response.json({ error: "Team discovery is not bound" }, { status: 503 });
      const scheduler = env.TASK_SCHEDULER.get(env.TASK_SCHEDULER.idFromName("global"));
      const query = new URLSearchParams();
      const year = url.searchParams.get("year");
      if (year !== null) query.set("year", year);
      return scheduler.fetch(new Request("https://task-scheduler/teams?" + query.toString()));
    }

    if (url.pathname === "/internal/admin/operations" && request.method === "POST") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || typeof body.kind !== "string" || typeof body.action !== "string") {
        return Response.json({ error: "Expected kind and action" }, { status: 400 });
      }
      const { kind, action } = body;
      if (kind === "system") {
        if (!env.TASK_SCHEDULER || !["scheduler-start", "scheduler-stop", "scheduler-run", "discover-year", "coverage-audit-start", "coverage-audit-continue", "season-ingest-preview", "season-ingest-start", "season-ingest-pause", "season-ingest-resume", "season-ingest-cancel"].includes(action)) {
          return Response.json({ error: "Unsupported system operation" }, { status: 400 });
        }
        const scheduler = env.TASK_SCHEDULER.get(env.TASK_SCHEDULER.idFromName("global"));
        if (action.startsWith("season-ingest-")) {
          const year = Number(body.year);
          if (!Number.isInteger(year) || year < 1992 || year > 2200) return Response.json({ error: "A valid season-ingest year is required" }, { status: 400 });
          const operation = action.slice("season-ingest-".length);
          const payload = { action: operation, year, ...(operation === "start" ? { confirm: body.confirm === true } : {}) };
          return scheduler.fetch(new Request("https://task-scheduler/admin/season-ingest", {
            method: "POST",
            headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }));
        }
        if (action === "coverage-audit-start" || action === "coverage-audit-continue") {
          const year = Number(body.year);
          if (!Number.isInteger(year) || year < 1992 || year > 2200) return Response.json({ error: "A valid audit year is required" }, { status: 400 });
          return scheduler.fetch(new Request("https://task-scheduler/admin/coverage-audit", {
            method: "POST",
            headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ action: action === "coverage-audit-start" ? "start" : "continue", year }),
          }));
        }
        if (action === "discover-year") {
          const year = Number(body.year);
          if (!Number.isInteger(year) || year < 1992 || year > 2200) {
            return Response.json({ error: "A valid discovery year is required" }, { status: 400 });
          }
          return scheduler.fetch(new Request("https://task-scheduler/admin/discover-year?year=" + year, {
            method: "POST", headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN },
          }));
        }
        return scheduler.fetch(new Request("https://task-scheduler/" + (action === "scheduler-start" ? "start" : action === "scheduler-stop" ? "stop" : "run"), {
          method: "POST", headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN },
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
          if (!env.TASK_SCHEDULER) return Response.json({ error: "TaskScheduler is not bound" }, { status: 503 });
          const year = body.year === undefined ? Number(key.slice(0, 4)) : Number(body.year);
          if (!Number.isInteger(year) || year < 1992 || year > 2200) return Response.json({ error: "Invalid event season year" }, { status: 400 });
          const scheduler = env.TASK_SCHEDULER.get(env.TASK_SCHEDULER.idFromName("global"));
          return scheduler.fetch(new Request("https://task-scheduler/admin/event-team-seed", {
            method: "POST", headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ event_key: key, year }),
          }));
        }
        await registerRuntimeObject(env, "event", key);
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
        return stub.fetch(new Request("https://event-runtime/" + path, {
          method: "POST", headers, body: JSON.stringify(payload),
        }));
      }
      if (kind === "team") {
        if (!["refresh", "seed"].includes(action)) return Response.json({ error: "Unsupported team operation" }, { status: 400 });
        if (!env.TEAM_RUNTIME) return Response.json({ error: "Team runtime is not bound" }, { status: 503 });
        const year = body.year === undefined ? new Date().getUTCFullYear() : Number(body.year);
        if (!Number.isInteger(year) || year < 1992 || year > new Date().getUTCFullYear() + 1) {
          return Response.json({ error: "Invalid season year" }, { status: 400 });
        }
        const teamKey = /^\d+$/.test(key) ? "frc" + key : key;
        await registerRuntimeObject(env, "team", teamKey);
        const stub = env.TEAM_RUNTIME.get(env.TEAM_RUNTIME.idFromName(teamKey));
        const teamResponse = await stub.fetch(new Request("https://team-runtime/" + action + "?year=" + year, {
          method: "POST",
          headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Team-Key": teamKey },
        }));
        if (action !== "seed" || !teamResponse.ok) return teamResponse;
        const teamResult = await teamResponse.clone().json() as {
          snapshot?: { events?: Array<Record<string, unknown>> | null };
        };
        let events = Array.isArray(teamResult.snapshot?.events) ? teamResult.snapshot.events : null;
        if (events === null) {
          // TeamRuntime seeding is now queued independently of recurring polling.
          // Let its durable alarm drain the season resources before reading history.
          const interval = Number(env.PROVIDER_REQUEST_INTERVAL_MS ?? 1_000);
          await new Promise<void>((resolve) => setTimeout(resolve, Math.max(8_000, interval * 9)));
          const refreshed = await stub.fetch(new Request("https://team-runtime/snapshot?year=" + year + "&noSchedule=1", {
            headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "X-FieldView-Team-Key": teamKey },
          }));
          if (refreshed.ok) {
            const snapshot = await refreshed.json() as { events?: Array<Record<string, unknown>> | null };
            events = Array.isArray(snapshot.events) ? snapshot.events : null;
            if (events !== null) teamResult.snapshot = snapshot;
          }
        }
        if (events === null) return Response.json({ error: "TeamRuntime seed is queued, but its event history is not ready yet. Retry the seed operation shortly." }, { status: 202 });
        const policy = eventPollingPolicy(env);
        const seededEvents: Array<{ event_key: string; status: number; body: unknown }> = [];
        for (const event of events) {
          const eventKey = event.key;
          if (typeof eventKey !== "string" || !/^[a-zA-Z0-9_-]+$/.test(eventKey)) continue;
          const eventStub = env.EVENT_RUNTIME.get(env.EVENT_RUNTIME.idFromName(eventKey));
          const lifecycle = classifyEventLifecycle({
            start_date: String(event.start_date ?? ""),
            end_date: String(event.end_date ?? ""),
            timezone: String(event.timezone ?? ""),
          }, Date.now(), policy);
          const eventHeaders = {
            Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN,
            "X-FieldView-Event-Key": eventKey,
            "Content-Type": "application/json",
          };
          let eventResponse: Response;
          if (!lifecycle || lifecycle.lifecycle === "expired") {
            eventResponse = await eventStub.fetch(new Request("https://event-runtime/schedule", {
              method: "POST", headers: eventHeaders,
              body: JSON.stringify({ endpoints: eventResourceEndpoints(eventKey), intervalMs: 86_400_000, analyticsEnabled: false }),
            }));
          } else {
            eventResponse = await eventStub.fetch(new Request("https://event-runtime/lifecycle", {
              method: "POST", headers: eventHeaders,
              body: JSON.stringify({
                lifecycle: lifecycle.lifecycle,
                analyticsEnabled: false,
                upcomingIntervalMs: policy.upcomingIntervalMs,
                activeIntervalMs: policy.activeIntervalMs,
                ...(lifecycle.completedUntil === null ? {} : { completedUntil: lifecycle.completedUntil }),
              }),
            }));
          }
          seededEvents.push({ event_key: eventKey, status: eventResponse.status, body: await eventResponse.json().catch(() => null) });
        }
        return Response.json({
          ...teamResult,
          event_seed: { requested: events.length, attempted: seededEvents.length, results: seededEvents },
        }, { status: teamResponse.status });
      }
      return Response.json({ error: "Unsupported operation kind" }, { status: 400 });
    }

    if (
      (url.pathname === "/internal/admin/inventory" || url.pathname === "/internal/admin/entity" || url.pathname === "/internal/admin/coverage-audit" || url.pathname === "/internal/admin/season-ingest" || url.pathname === "/internal/admin/event-team-seed" || url.pathname === "/internal/admin/district-refresh") &&
      (request.method === "GET" || ((url.pathname === "/internal/admin/coverage-audit" || url.pathname === "/internal/admin/season-ingest" || url.pathname === "/internal/admin/event-team-seed" || url.pathname === "/internal/admin/district-refresh") && request.method === "POST"))
    ) {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (!env.TASK_SCHEDULER) return Response.json({ error: "TaskScheduler is not bound" }, { status: 503 });
      const scheduler = env.TASK_SCHEDULER.get(env.TASK_SCHEDULER.idFromName("global"));
      const headers = new Headers(request.headers);
      headers.set("Authorization", "Bearer " + env.RUNTIME_ADMIN_TOKEN);
      return scheduler.fetch(new Request("https://task-scheduler" + url.pathname.replace("/internal", "") + url.search, {
        method: request.method,
        headers,
        ...(request.method === "GET" ? {} : { body: request.body }),
      }));
    }

    if (url.pathname === "/internal/admin/overview" && request.method === "GET") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (!env.TASK_SCHEDULER) return Response.json({ error: "TaskScheduler is not bound" }, { status: 503 });
      const scheduler = env.TASK_SCHEDULER.get(env.TASK_SCHEDULER.idFromName("global"));
      return scheduler.fetch(new Request("https://task-scheduler/admin/overview", {
        headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN },
      }));
    }

    // District data is owned by TaskScheduler; these public routes are strictly read-only.
    if (url.pathname === "/districts/discovery" && request.method === "GET") {
      if (!env.TASK_SCHEDULER) return Response.json({ error: "TaskScheduler is not bound" }, { status: 503 });
      const scheduler = env.TASK_SCHEDULER.get(env.TASK_SCHEDULER.idFromName("global"));
      const response = await scheduler.fetch(new Request("https://task-scheduler/districts" + url.search));
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(response.body, { status: response.status, headers });
    }
    const districtRoute = /^\/districts\/([a-zA-Z0-9_-]+)\/snapshot$/.exec(url.pathname);
    if (districtRoute && request.method === "GET") {
      if (!env.TASK_SCHEDULER) return Response.json({ error: "TaskScheduler is not bound" }, { status: 503 });
      const scheduler = env.TASK_SCHEDULER.get(env.TASK_SCHEDULER.idFromName("global"));
      const query = new URLSearchParams(url.search);
      query.set("key", districtRoute[1]);
      const response = await scheduler.fetch(new Request("https://task-scheduler/district?" + query.toString()));
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(response.body, { status: response.status, headers });
    }

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
      if (!env.TEAM_RUNTIME) return Response.json({ error: "Team runtime is not bound" }, { status: 503 });
      await registerRuntimeObject(env, "team", internalTeamKey);
      const stub = env.TEAM_RUNTIME.get(env.TEAM_RUNTIME.idFromName(internalTeamKey));
      const headers = new Headers(request.headers);
      headers.set("X-FieldView-Team-Key", internalTeamKey);
      const teamResponse = await stub.fetch(new Request("https://team-runtime/" + internalTeamAction + url.search, {
        method: request.method, headers,
      }));
      if (internalTeamAction !== "seed" || request.method !== "POST" || !teamResponse.ok) {
        return teamResponse;
      }

      // A team seed is a bounded bootstrap of the complete team profile:
      // first acquire the team resources, then initialize every associated
      // event's canonical EventRuntime snapshot through its admin lifecycle API.
      const teamResult = await teamResponse.clone().json() as {
        snapshot?: { events?: Array<Record<string, unknown>> | null };
      };
      const events = Array.isArray(teamResult.snapshot?.events) ? teamResult.snapshot.events : [];
      const policy = eventPollingPolicy(env);
      const seededEvents: Array<{ event_key: string; status: number; body: unknown }> = [];
      for (const event of events) {
        const eventKey = event.key;
        if (typeof eventKey !== "string" || !/^[a-zA-Z0-9_-]+$/.test(eventKey)) continue;
        await registerRuntimeObject(env, "event", eventKey);
        const eventStub = env.EVENT_RUNTIME.get(env.EVENT_RUNTIME.idFromName(eventKey));
        const lifecycle = classifyEventLifecycle({
          start_date: String(event.start_date ?? ""),
          end_date: String(event.end_date ?? ""),
          timezone: String(event.timezone ?? ""),
        }, Date.now(), policy);
        const eventHeaders = {
          Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN,
          "X-FieldView-Event-Key": eventKey,
          "Content-Type": "application/json",
        };
        let eventResponse: Response;
        if (!lifecycle || lifecycle.lifecycle === "expired") {
          // Historical events remain useful on team profiles. Seed all their
          // resources once and retain a slow daily refresh instead of skipping
          // them merely because their live polling retention has elapsed.
          eventResponse = await eventStub.fetch(new Request("https://event-runtime/schedule", {
            method: "POST",
            headers: eventHeaders,
            body: JSON.stringify({ endpoints: eventResourceEndpoints(eventKey), intervalMs: 86_400_000 }),
          }));
        } else {
          eventResponse = await eventStub.fetch(new Request("https://event-runtime/lifecycle", {
            method: "POST",
            headers: eventHeaders,
            body: JSON.stringify({
              lifecycle: lifecycle.lifecycle,
              upcomingIntervalMs: policy.upcomingIntervalMs,
              activeIntervalMs: policy.activeIntervalMs,
              ...(lifecycle.completedUntil === null ? {} : { completedUntil: lifecycle.completedUntil }),
            }),
          }));
        }
        seededEvents.push({
          event_key: eventKey,
          status: eventResponse.status,
          body: await eventResponse.json().catch(() => null),
        });
      }
      return Response.json({
        ...teamResult,
        event_seed: {
          requested: events.length,
          attempted: seededEvents.length,
          results: seededEvents,
        },
      }, { status: teamResponse.status });
    }

    if (url.pathname === "/stream" && request.method === "GET" && env.MULTIPLEXER) {
      const stub = env.MULTIPLEXER.get(env.MULTIPLEXER.idFromName("shared"));
      return stub.fetch(new Request("https://fieldview-multiplexer/stream", { method: "GET", headers: request.headers }));
    }

    if (url.pathname === "/internal/scheduler/start" || url.pathname === "/internal/scheduler/stop" || url.pathname === "/internal/scheduler/state") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (!env.TASK_SCHEDULER) return Response.json({ error: "TaskScheduler is not bound" }, { status: 503 });
      const scheduler = env.TASK_SCHEDULER.get(env.TASK_SCHEDULER.idFromName("global"));
      const action = url.pathname.endsWith("/start") ? "start" : url.pathname.endsWith("/stop") ? "stop" : "state";
      return scheduler.fetch(new Request("https://task-scheduler/" + action, {
        method: action === "state" ? "GET" : "POST",
        headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN },
      }));
    }

    if (url.pathname === "/health") {
      return Response.json({ service: "fieldview-runtime", status: "ok" });
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
      // Public snapshots are read-only. Event registration belongs to discovery and lifecycle workflows.
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
      ["schedule", "state", "snapshot", "stream", "lifecycle", "refresh", "recalculate", "statbotics-refresh"].includes(action ?? "");
    if (!validRoute || !authorized(request, env)) {
      return Response.json({ error: "Not found" }, { status: validRoute ? 401 : 404 });
    }

    await registerRuntimeObject(env, "event", eventKey);
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

  async scheduled(
    _controller: { scheduledTime: number; cron: string },
    env: RuntimeEnvironment,
    context: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void> {
    if (!env.TASK_SCHEDULER) {
      console.error("[FV][TaskScheduler] Daily event classification skipped: TaskScheduler is not bound");
      return;
    }
    const scheduler = env.TASK_SCHEDULER.get(env.TASK_SCHEDULER.idFromName("global"));
    context.waitUntil((async () => {
      const response = await scheduler.fetch(new Request("https://task-scheduler/daily", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN },
      }));
      if (!response.ok) throw new Error("Daily TaskScheduler run failed with HTTP " + response.status);
      const result = await response.json();
      console.log("[FV][TaskScheduler] Daily run completed", JSON.stringify(result));
    })());
  },
};
