import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

function makeEnvironment() {
  const calls = [];
  return {
    calls,
    env: {
      RUNTIME_ADMIN_TOKEN: "server-only-token",
      EVENT_RUNTIME: {
        idFromName(name) { calls.push({ operation: "id", name }); return name; },
        get(id) {
          return {
            async fetch(request) {
              calls.push({
                operation: "fetch",
                id,
                url: new URL(request.url).pathname + new URL(request.url).search,
                method: request.method,
                headers: new Headers(request.headers),
              });
              return Response.json(
                { ok: true },
                { headers: { "X-FieldView-Snapshot-Version": "12" } },
              );
            },
          };
        },
      },
    },
  };
}

test("public event snapshot route forwards without user credentials and exposes its version", async () => {
  const { env, calls } = makeEnvironment();
  const response = await worker.fetch(
    new Request("https://runtime.example/events/2026test/snapshot"),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Access-Control-Expose-Headers"), "X-FieldView-Snapshot-Version");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-FieldView-Snapshot-Version"), "12");
  assert.deepEqual(await response.json(), { ok: true });
  const forwarded = calls.find((call) => call.operation === "fetch");
  assert.equal(forwarded.url, "/snapshot");
  assert.equal(forwarded.method, "GET");
  assert.equal(forwarded.headers.get("X-FieldView-Event-Key"), "2026test");
  assert.equal(forwarded.headers.get("Authorization"), null);
});

test("public event stream route forwards WebSocket upgrade and since revision", async () => {
  const { env, calls } = makeEnvironment();
  await worker.fetch(
    new Request("https://runtime.example/events/2026test/stream?since=11", {
      headers: { Upgrade: "websocket" },
    }),
    env,
  );
  const forwarded = calls.find((call) => call.operation === "fetch");
  assert.equal(forwarded.url, "/stream?since=11");
  assert.equal(forwarded.headers.get("Upgrade"), "websocket");
  assert.equal(forwarded.headers.get("Authorization"), null);
});

test("public routes reject writes and malformed event keys", async () => {
  const { env, calls } = makeEnvironment();
  const write = await worker.fetch(
    new Request("https://runtime.example/events/2026test/snapshot", { method: "POST" }),
    env,
  );
  const malformed = await worker.fetch(
    new Request("https://runtime.example/events/bad%2Fkey/snapshot"),
    env,
  );
  assert.equal(write.status, 404);
  assert.equal(malformed.status, 404);
  assert.equal(calls.some((call) => call.operation === "fetch"), false);
});

test("internal administrative routes still require the service bearer token", async () => {
  const { env, calls } = makeEnvironment();
  const denied = await worker.fetch(
    new Request("https://runtime.example/internal/events/2026test/state"),
    env,
  );
  assert.equal(denied.status, 401);
  assert.equal(calls.some((call) => call.operation === "fetch"), false);

  const allowed = await worker.fetch(
    new Request("https://runtime.example/internal/events/2026test/state", {
      headers: { Authorization: "Bearer server-only-token" },
    }),
    env,
  );
  assert.equal(allowed.status, 200);
});
