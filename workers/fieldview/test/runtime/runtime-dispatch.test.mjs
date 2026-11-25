import assert from "node:assert/strict";
import test from "node:test";
import { dispatchRuntime } from "../../src/runtime/runtime-dispatch.ts";

function namespace(handler) {
  return {
    idFromName(name) { return name; },
    get(id) { return { fetch: (request) => handler(request, id) }; },
  };
}

test("event dispatch calls EventRuntime directly and records its runtime marker", async () => {
  const calls = [];
  const markers = new Map();
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    EVENT_RUNTIME: namespace(async (request, id) => {
      calls.push({ url: new URL(request.url), id, headers: request.headers });
      return Response.json({ ready: true, team_keys: ["frc1"] });
    }),
    DISCOVERY_STORE: namespace(async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/get") {
        const key = url.searchParams.get("key");
        return markers.has(key) ? Response.json({ value: markers.get(key) }) : new Response(null, { status: 404 });
      }
      const body = await request.json();
      markers.set(body.key, body.value);
      return Response.json({ ok: true });
    }),
  };

  const response = await dispatchRuntime(env, "event", "2026test", "participants", {}, 2026);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ready: true, team_keys: ["frc1"] });
  assert.equal(calls[0].id, "2026test");
  assert.equal(calls[0].url.pathname, "/participants");
  assert.equal(calls[0].headers.get("X-FieldView-Event-Key"), "2026test");
  assert.equal(calls[0].headers.get("Authorization"), "Bearer test-token");
  assert.equal(markers.get("registry/runtime-events/2026test.json"), "{}");
});

test("lifecycle dispatch forwards configured polling intervals to EventRuntime", async () => {
  let capturedBody;
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    EVENT_UPCOMING_INTERVAL_MS: "1800000",
    EVENT_ACTIVE_INTERVAL_MS: "300000",
    EVENT_RUNTIME: namespace(async (request) => {
      assert.equal(new URL(request.url).pathname, "/lifecycle");
      capturedBody = await request.json();
      return Response.json({ queued: true }, { status: 202 });
    }),
  };

  const response = await dispatchRuntime(env, "event", "2027rikin", "lifecycle", {
    lifecycle: "upcoming",
  }, 2027);

  assert.equal(response.status, 202);
  assert.deepEqual(capturedBody, {
    lifecycle: "upcoming",
    upcomingIntervalMs: 1_800_000,
    activeIntervalMs: 300_000,
  });
});

test("team seed dispatch calls TeamRuntime directly with the requested season", async () => {
  let captured;
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    TEAM_RUNTIME: namespace(async (request, id) => {
      captured = { url: new URL(request.url), id, headers: request.headers };
      return new Response(null, { status: 202 });
    }),
    DISCOVERY_STORE: namespace(async () => Response.json({ ok: true })),
  };

  const response = await dispatchRuntime(env, "team", "frc3461", "seed", {}, 2026);
  assert.equal(response.status, 202);
  assert.equal(captured.id, "frc3461");
  assert.equal(captured.url.pathname, "/seed");
  assert.equal(captured.url.searchParams.get("year"), "2026");
  assert.equal(captured.headers.get("X-FieldView-Team-Key"), "frc3461");
});

test("readiness dispatch sends inspection-only requests to both runtime types", async () => {
  const captured = [];
  let markerWrites = 0;
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    EVENT_RUNTIME: namespace(async (request, id) => {
      captured.push({ kind: "event", id, url: new URL(request.url), method: request.method, body: await request.json() });
      return Response.json({ state_valid: false, refresh_queued: true });
    }),
    TEAM_RUNTIME: namespace(async (request, id) => {
      captured.push({ kind: "team", id, url: new URL(request.url), method: request.method, body: await request.json() });
      return Response.json({ state_valid: false, refresh_queued: true });
    }),
    DISCOVERY_STORE: namespace(async (request) => {
      if (request.method === "GET") return new Response(null, { status: 404 });
      markerWrites += 1;
      return Response.json({ ok: true });
    }),
  };
  const event = await dispatchRuntime(env, "event", "2027rikin", "readiness", {}, 2027);
  const team = await dispatchRuntime(env, "team", "frc3461", "readiness", {}, 2027);
  assert.equal(event.status, 200);
  assert.equal(team.status, 200);
  assert.deepEqual(captured.map(({ kind, id, url, method, body }) => ({
    kind, id, path: url.pathname, year: url.searchParams.get("year"), method, body,
  })), [
    { kind: "event", id: "2027rikin", path: "/readiness", year: null, method: "POST", body: {} },
    { kind: "team", id: "frc3461", path: "/readiness", year: "2027", method: "POST", body: {} },
  ]);
  assert.equal(markerWrites, 0, "readiness never creates runtime registry records");
});


test("team refresh starts a durable analytics Workflow for only the related event", async () => {
  const workflowCalls = [];
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    TEAM_RUNTIME: namespace(async () => Response.json({
      team_state_revision: 8,
      affected_events: [
        { event_key: "2027rikin", team_event_revision: 3 },
        { event_key: "2027other", team_event_revision: 5 },
      ],
    })),
    EVENT_ANALYTICS_WORKFLOW: {
      get: async () => { throw new Error("Workflow instance does not exist"); },
      create: async (input) => { workflowCalls.push(input); return {}; },
    },
  };

  const response = await dispatchRuntime(env, "team", "frc3461", "refresh", {
    related_event_key: "2027rikin",
  }, 2027);

  assert.equal(response.status, 200);
  assert.equal(workflowCalls.length, 1);
  assert.equal(workflowCalls[0].id, "team-event-analytics-2027rikin-frc3461-8-3");
  assert.deepEqual(workflowCalls[0].params, {
    event_key: "2027rikin",
    affected_team_keys: null,
    requested_at: workflowCalls[0].params.requested_at,
  });
  assert.ok(Number.isSafeInteger(workflowCalls[0].params.requested_at));
});

test("dispatch rejects unsupported actions and invalid entity keys", async () => {
  const env = { RUNTIME_ADMIN_TOKEN: "test-token" };
  assert.equal((await dispatchRuntime(env, "event", "bad key", "state", {}, 2026)).status, 400);
  assert.equal((await dispatchRuntime(env, "team", "frc3461", "unknown", {}, 2026)).status, 503);
});


test("team dispatch defaults to persisted TBA current season instead of the system year", async () => {
  let captured;
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    TEAM_RUNTIME: namespace(async (request) => {
      captured = new URL(request.url);
      return new Response(null, { status: 202 });
    }),
    DISCOVERY_STORE: namespace(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/get") return Response.json({ year: 2027, checkedAt: Date.now() });
      return Response.json({ ok: true });
    }),
  };
  const response = await dispatchRuntime(env, "team", "frc3461", "seed");
  assert.equal(response.status, 202);
  assert.equal(captured.searchParams.get("year"), "2027");
});

test("team dispatch refuses to infer a season when the TBA current-season pointer is missing", async () => {
  let activated = false;
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    TEAM_RUNTIME: namespace(async () => { activated = true; return new Response(null, { status: 202 }); }),
    DISCOVERY_STORE: namespace(async () => new Response(null, { status: 404 })),
  };
  const response = await dispatchRuntime(env, "team", "frc3461", "seed");
  assert.equal(response.status, 503);
  assert.equal(activated, false);
});
