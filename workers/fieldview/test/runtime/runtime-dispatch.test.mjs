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
    DISCOVERY_STORAGE: {
      async get(key) { return markers.get(key); },
      async put(key, value) { markers.set(key, value); },
      async list() { return new Map(); },
      async delete(key) { return markers.delete(key); },
    },
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

test("event registration binds the runtime identity without scheduling provider work", async () => {
  const markers = new Map();
  let captured;
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    EVENT_RUNTIME: namespace(async (request, id) => {
      captured = { path: new URL(request.url).pathname, method: request.method, id, headers: request.headers };
      return Response.json({ event_key: id, registered: true });
    }),
    DISCOVERY_STORAGE: {
      async get(key) { return markers.get(key); },
      async put(key, value) { markers.set(key, value); },
      async list() { return new Map(); },
      async delete(key) { return markers.delete(key); },
    },
  };
  const response = await dispatchRuntime(env, "event", "2027rikin", "register", {}, 2027);
  assert.equal(response.status, 200);
  assert.deepEqual({ path: captured.path, method: captured.method, id: captured.id }, {
    path: "/register", method: "POST", id: "2027rikin",
  });
  assert.equal(captured.headers.get("X-FieldView-Event-Key"), "2027rikin");
  assert.equal(markers.get("registry/runtime-events/2027rikin.json"), "{}");
});

test("team seed dispatch calls TeamRuntime directly with the requested season", async () => {
  let captured;
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    TEAM_RUNTIME: namespace(async (request, id) => {
      captured = { url: new URL(request.url), id, headers: request.headers };
      return new Response(null, { status: 202 });
    }),
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


test("team runtime dispatch does not directly orchestrate EventRuntime analytics", async () => {
  const eventCalls = [];
  const workflowCalls = [];
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    TEAM_RUNTIME: namespace(async () => Response.json({
      team_state_revision: 8,
      affected_events: [{ event_key: "2027rikin", team_event_revision: 3 }],
    })),
    EVENT_RUNTIME: namespace(async (request, id) => {
      eventCalls.push({ id, path: new URL(request.url).pathname });
      return Response.json({ accepted: true });
    }),
    EVENT_ANALYTICS_WORKFLOW: {
      get: async () => { throw new Error("Workflow instance does not exist"); },
      create: async (input) => { workflowCalls.push(input); return {}; },
    },
  };

  const response = await dispatchRuntime(env, "team", "frc3461", "refresh", {}, 2027);

  assert.equal(response.status, 200);
  assert.deepEqual(eventCalls, []);
  assert.deepEqual(workflowCalls, [],
    "cross-runtime orchestration is deferred to the refresh coordinator");
});

test("pending analytics dispatch is an authenticated read of the registered TeamRuntime", async () => {
  let captured, discoveryCalls = 0;
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    TEAM_RUNTIME: namespace(async (request, id) => {
      captured = { method: request.method, url: new URL(request.url), id, headers: request.headers };
      return Response.json({ team_key: id, year: 2027, pending: [] });
    }),
  };
  const response = await dispatchRuntime(env, "team", "frc3461", "pending-analytics", {}, 2027);
  assert.equal(response.status, 200);
  assert.equal(captured.method, "GET");
  assert.equal(captured.url.pathname, "/pending-event-analytics");
  assert.equal(captured.url.searchParams.get("year"), "2027");
  assert.equal(captured.headers.get("Authorization"), "Bearer test-token");
  assert.equal(captured.headers.get("X-FieldView-Team-Key"), "frc3461");
  assert.equal(discoveryCalls, 0, "inspection must not register or initialize a runtime");
});
test("dispatch rejects retired scheduling actions and invalid entity keys", async () => {
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    EVENT_RUNTIME: namespace(async () => new Response()),
    TEAM_RUNTIME: namespace(async () => new Response()),
  };
  assert.equal((await dispatchRuntime(env, "event", "bad key", "state", {}, 2026)).status, 400);
  assert.equal((await dispatchRuntime(env, "team", "frc3461", "unknown", {}, 2026)).status, 400);
  assert.equal((await dispatchRuntime(env, "event", "2026rikin", "lifecycle", {}, 2026)).status, 400);
  assert.equal((await dispatchRuntime(env, "event", "2026rikin", "schedule", {}, 2026)).status, 400);
});


test("team dispatch defaults to persisted TBA current season instead of the system year", async () => {
  let captured;
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    TEAM_RUNTIME: namespace(async (request) => {
      captured = new URL(request.url);
      return new Response(null, { status: 202 });
    }),
    DISCOVERY_STORAGE: {
      async get(key) { return key === "discovery/current-season.json" ? JSON.stringify({ year: 2027, checkedAt: Date.now() }) : undefined; },
      async put() {}, async list() { return new Map(); }, async delete() { return false; },
    },
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
    DISCOVERY_STORAGE: { async get() { return undefined; }, async put() {}, async list() { return new Map(); }, async delete() { return false; } },
  };
  const response = await dispatchRuntime(env, "team", "frc3461", "seed");
  assert.equal(response.status, 503);
  assert.equal(activated, false);
});
