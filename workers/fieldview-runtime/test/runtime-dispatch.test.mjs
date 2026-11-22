import assert from "node:assert/strict";
import test from "node:test";
import { dispatchRuntime } from "../src/runtime-dispatch.ts";

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

test("dispatch rejects unsupported actions and invalid entity keys", async () => {
  const env = { RUNTIME_ADMIN_TOKEN: "test-token" };
  assert.equal((await dispatchRuntime(env, "event", "bad key", "state", {}, 2026)).status, 400);
  assert.equal((await dispatchRuntime(env, "team", "frc3461", "unknown", {}, 2026)).status, 503);
});
