import assert from "node:assert/strict";
import test from "node:test";
import runtime from "../../src/runtime/index.ts";
const worker = {
  fetch(request, env) {
    if (env.DISCOVERY_STORE && !env.DISCOVERY_STORAGE) {
      const stub = env.DISCOVERY_STORE.get(env.DISCOVERY_STORE.idFromName("shared"));
      env.DISCOVERY_STORAGE = {
        async get(key) {
          const response = await stub.fetch(new Request("https://discovery-store/get?key=" + encodeURIComponent(key)));
          return response.ok ? response.text() : undefined;
        },
        async put(key, value) {
          await stub.fetch(new Request("https://discovery-store/put", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, value }),
          }));
        },
        async list() { return new Map(); },
        async delete() { return false; },
      };
    }
    return runtime.fetch(request, env);
  },
};

function environment() {
  const calls = [];
  const markers = [];
  const namespace = (kind) => ({
    idFromName: (key) => key,
    get: (id) => ({
      fetch: async (request) => {
        calls.push({ kind, id, path: new URL(request.url).pathname + new URL(request.url).search,
          method: request.method, headers: Object.fromEntries(request.headers.entries()),
          body: request.method === "POST" ? await request.clone().text() : null });
        return Response.json({ accepted: true }, { status: 202 });
      },
    }),
  });
  return {
    calls, markers,
    env: {
      RUNTIME_ADMIN_TOKEN: "test-token",
      EVENT_RUNTIME: namespace("event"),
      TEAM_RUNTIME: namespace("team"),
      DISCOVERY_STORE: {
        idFromName: (name) => name,
        get: () => ({
          fetch: async (request) => {
            const url = new URL(request.url);
            if (url.pathname === "/get") return new Response(null, { status: 404 });
            assert.equal(url.pathname, "/put");
            const body = await request.json();
            markers.push(body.key);
            return Response.json({ ok: true });
          },
        }),
      },
    },
  };
}

async function dispatch(env, body, authorization = "Bearer test-token") {
  return worker.fetch(new Request("https://fieldview-runtime/internal/workflows/dispatch", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), env);
}

test("Workflow dispatch sends team seed and state commands to the owning TeamRuntime", async () => {
  const { env, calls, markers } = environment();
  const seed = await dispatch(env, { kind: "team", key: "frc3461", action: "seed", year: 2026 });
  assert.equal(seed.status, 202);
  const state = await dispatch(env, { kind: "team", key: "frc3461", action: "state", year: 2026 });
  assert.equal(state.status, 202);
  assert.deepEqual(calls.map((call) => [call.kind, call.id, call.path, call.method]), [
    ["team", "frc3461", "/seed?year=2026", "POST"],
    ["team", "frc3461", "/state?year=2026", "GET"],
  ]);
  assert.deepEqual(markers, ["registry/runtime-teams/frc3461.json"], "read-only state inspection must not register a runtime");
});

test("Workflow dispatch sends participant acquisition and explicit refresh commands to EventRuntime", async () => {
  const { env, calls, markers } = environment();
  const participants = await dispatch(env, { kind: "event", key: "2026rikin", action: "participants", year: 2026 });
  assert.equal(participants.status, 202);
  const refresh = await dispatch(env, {
    kind: "event", key: "2026rikin", action: "refresh", year: 2026,
  });
  assert.equal(refresh.status, 202);
  assert.deepEqual(calls.map((call) => [call.kind, call.id, call.path, call.method]), [
    ["event", "2026rikin", "/participants", "POST"],
    ["event", "2026rikin", "/refresh", "POST"],
  ]);
  assert.deepEqual(JSON.parse(calls[1].body), {});
  assert.deepEqual(markers, ["registry/runtime-events/2026rikin.json", "registry/runtime-events/2026rikin.json"]);
});

test("Workflow dispatch rejects unauthorized and malformed runtime commands", async () => {
  const { env, calls } = environment();
  assert.equal((await dispatch(env, { kind: "team", key: "frc3461", action: "seed", year: 2026 }, "Bearer wrong")).status, 401);
  assert.equal((await dispatch(env, { kind: "team", key: "not-a-team", action: "seed", year: 2026 })).status, 400);
  assert.equal((await dispatch(env, { kind: "event", key: "2026rikin", action: "unknown", year: 2026 })).status, 400);
  assert.equal(calls.length, 0);
});


test("Workflow dispatch keeps EventRuntime state inspection read-only", async () => {
  const { env, calls, markers } = environment();
  const state = await dispatch(env, { kind: "event", key: "2026rikin", action: "state", year: 2026 });
  assert.equal(state.status, 202);
  const analytics = await dispatch(env, { kind: "event", key: "2026rikin", action: "analytics-state", year: 2026 });
  assert.equal(analytics.status, 202);
  assert.deepEqual(calls.map((call) => [call.path, call.method]), [
    ["/state", "GET"],
    ["/analytics-state", "GET"],
  ]);
  assert.deepEqual(markers, [], "inspection GETs must not create runtime registry markers");
});
