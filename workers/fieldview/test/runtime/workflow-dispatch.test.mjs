import assert from "node:assert/strict";
import test from "node:test";
import worker from "../../src/runtime/index.ts";

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
  assert.deepEqual(markers, ["registry/runtime-teams/frc3461.json", "registry/runtime-teams/frc3461.json"]);
});

test("Workflow dispatch sends participant acquisition and lifecycle commands to EventRuntime", async () => {
  const { env, calls, markers } = environment();
  const participants = await dispatch(env, { kind: "event", key: "2026rikin", action: "participants", year: 2026 });
  assert.equal(participants.status, 202);
  const lifecycle = await dispatch(env, {
    kind: "event", key: "2026rikin", action: "lifecycle", year: 2026,
    lifecycle: "active", upcomingIntervalMs: 1_800_000, activeIntervalMs: 300_000,
  });
  assert.equal(lifecycle.status, 202);
  assert.deepEqual(calls.map((call) => [call.kind, call.id, call.path, call.method]), [
    ["event", "2026rikin", "/participants", "POST"],
    ["event", "2026rikin", "/lifecycle", "POST"],
  ]);
  assert.deepEqual(JSON.parse(calls[1].body), {
    lifecycle: "active", upcomingIntervalMs: 1_800_000, activeIntervalMs: 300_000,
  });
  assert.deepEqual(markers, ["registry/runtime-events/2026rikin.json", "registry/runtime-events/2026rikin.json"]);
});

test("Workflow dispatch rejects unauthorized and malformed runtime commands", async () => {
  const { env, calls } = environment();
  assert.equal((await dispatch(env, { kind: "team", key: "frc3461", action: "seed", year: 2026 }, "Bearer wrong")).status, 401);
  assert.equal((await dispatch(env, { kind: "team", key: "not-a-team", action: "seed", year: 2026 })).status, 400);
  assert.equal((await dispatch(env, { kind: "event", key: "2026rikin", action: "unknown", year: 2026 })).status, 400);
  assert.equal(calls.length, 0);
});
