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
  assert.equal(response.headers.get("Access-Control-Expose-Headers"), "X-FieldView-Snapshot-Version, X-FieldView-Analytics-Version");
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



test("admin team seed ingests team resources and initializes every event runtime", async () => {
  const calls = [];
  const events = [
    { key: "2026past", start_date: "2026-03-01", end_date: "2026-03-02", timezone: "America/New_York" },
    { key: "2026future", start_date: "2026-12-06", end_date: "2026-12-08", timezone: "America/New_York" },
  ];
  const env = {
    RUNTIME_ADMIN_TOKEN: "server-only-token",
    TEAM_RUNTIME: {
      idFromName(name) { calls.push({ operation: "team-id", name }); return name; },
      get(id) {
        return { async fetch(request) {
          calls.push({ operation: "team-fetch", id, path: new URL(request.url).pathname + new URL(request.url).search });
          return Response.json({ attempted: true, snapshot: { events } });
        } };
      },
    },
    EVENT_RUNTIME: {
      idFromName(name) { calls.push({ operation: "event-id", name }); return name; },
      get(id) {
        return { async fetch(request) {
          const body = request.method === "POST" ? await request.json() : null;
          calls.push({ operation: "event-fetch", id, path: new URL(request.url).pathname, body });
          return Response.json({ attempted: true });
        } };
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://runtime.example/internal/teams/3461/seed?year=2026", {
      method: "POST",
      headers: { Authorization: "Bearer server-only-token" },
    }),
    env,
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.event_seed.requested, 2);
  assert.ok(calls.some((call) => call.operation === "team-id" && call.name === "frc3461"));
  assert.ok(calls.some((call) => call.operation === "team-fetch" && call.id === "frc3461"));
  assert.equal(result.event_seed.attempted, 2);
  const past = calls.find((call) => call.operation === "event-fetch" && call.id === "2026past");
  const future = calls.find((call) => call.operation === "event-fetch" && call.id === "2026future");
  assert.equal(past.path, "/schedule");
  assert.equal(past.body.intervalMs, 86_400_000);
  assert.equal(past.body.endpoints.length, 12);
  assert.equal(future.path, "/lifecycle");
  assert.equal(future.body.lifecycle, "upcoming");
});

test("shared public stream route forwards to the single multiplexer without credentials", async () => {
  const calls = [];
  const env = {
    RUNTIME_ADMIN_TOKEN: "server-only-token",
    EVENT_RUNTIME: {
      idFromName(name) { return name; },
      get() { throw new Error("event runtime must not receive the shared stream"); },
    },
    MULTIPLEXER: {
      idFromName(name) { calls.push({ operation: "id", name }); return name; },
      get(id) {
        return {
          async fetch(request) {
            calls.push({
              operation: "fetch",
              id,
              path: new URL(request.url).pathname,
              method: request.method,
              upgrade: request.headers.get("Upgrade"),
              authorization: request.headers.get("Authorization"),
            });
            return new Response(null, { status: 200 });
          },
        };
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://runtime.example/stream", { headers: { Upgrade: "websocket" } }),
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    { operation: "id", name: "shared" },
    {
      operation: "fetch",
      id: "shared",
      path: "/stream",
      method: "GET",
      upgrade: "websocket",
      authorization: null,
    },
  ]);
});

test("public event discovery route reads the global scheduler cache without credentials", async () => {
  const calls = [];
  const env = {
    EVENT_SCHEDULER: {
      idFromName(name) { calls.push({ operation: "id", name }); return name; },
      get(id) {
        return {
          async fetch(request) {
            calls.push({
              operation: "fetch",
              id,
              url: new URL(request.url).pathname + new URL(request.url).search,
              method: request.method,
              authorization: request.headers.get("Authorization"),
            });
            return Response.json({ year: 2026, events: [] });
          },
        };
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://runtime.example/events/discovery?year=2026"),
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    { operation: "id", name: "global" },
    {
      operation: "fetch",
      id: "global",
      url: "/events?year=2026",
      method: "GET",
      authorization: null,
    },
  ]);
});


test("public team discovery route reads the global scheduler cache without credentials", async () => {
  const calls = [];
  const env = {
    EVENT_SCHEDULER: {
      idFromName(name) { calls.push({ operation: "id", name }); return name; },
      get(id) {
        return {
          async fetch(request) {
            calls.push({
              operation: "fetch",
              id,
              url: new URL(request.url).pathname + new URL(request.url).search,
              method: request.method,
              authorization: request.headers.get("Authorization"),
            });
            return Response.json({ year: 2026, teams: [] });
          },
        };
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://runtime.example/teams/discovery?year=2026"),
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    { operation: "id", name: "global" },
    {
      operation: "fetch",
      id: "global",
      url: "/teams?year=2026",
      method: "GET",
      authorization: null,
    },
  ]);
});

test("internal lifecycle mutation route requires admin auth and forwards the request body", async () => {
  const { env, calls } = makeEnvironment();
  const body = { lifecycle: "active", upcomingIntervalMs: 1800000, activeIntervalMs: 300000 };
  const denied = await worker.fetch(
    new Request("https://runtime.example/internal/events/2026probe/lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
  assert.equal(denied.status, 401);
  assert.equal(calls.some((call) => call.operation === "fetch"), false);

  const allowed = await worker.fetch(
    new Request("https://runtime.example/internal/events/2026probe/lifecycle", {
      method: "POST",
      headers: {
        Authorization: "Bearer server-only-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
  );
  assert.equal(allowed.status, 200);
  const forwarded = calls.find((call) => call.operation === "fetch");
  assert.equal(forwarded.id, "2026probe");
  assert.equal(forwarded.url, "/lifecycle");
  assert.equal(forwarded.method, "POST");
  assert.equal(forwarded.headers.get("Authorization"), "Bearer server-only-token");
});


test("public team snapshot route selects the team Durable Object and forwards the season", async () => {
  const calls = [];
  const env = {
    TEAM_RUNTIME: {
      idFromName(name) { calls.push({ operation: "id", name }); return name; },
      get(id) {
        return { async fetch(request) {
          calls.push({
            operation: "fetch", id,
            url: new URL(request.url).pathname + new URL(request.url).search,
            teamKey: request.headers.get("X-FieldView-Team-Key"),
            authorization: request.headers.get("Authorization"),
          });
          return Response.json(
            { team_key: "frc3461", year: 2026, sources: {} },
            { headers: { "X-FieldView-Snapshot-Version": "4" } },
          );
        } };
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://runtime.example/teams/frc3461/snapshot?year=2026"),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("X-FieldView-Snapshot-Version"), "4");
  assert.deepEqual(await response.json(), { team_key: "frc3461", year: 2026, sources: {} });
  assert.deepEqual(calls, [
    { operation: "id", name: "frc3461" },
    { operation: "fetch", id: "frc3461", url: "/snapshot?year=2026", teamKey: "frc3461", authorization: null },
  ]);
});

test("internal team refresh route requires service authentication", async () => {
  const calls = [];
  const env = {
    RUNTIME_ADMIN_TOKEN: "server-only-token",
    TEAM_RUNTIME: {
      idFromName(name) { calls.push({ operation: "id", name }); return name; },
      get(id) {
        return { async fetch(request) {
          calls.push({ operation: "fetch", id, path: new URL(request.url).pathname, method: request.method });
          return Response.json({ scheduled: true });
        } };
      },
    },
  };
  const denied = await worker.fetch(
    new Request("https://runtime.example/internal/teams/frc3461/refresh?year=2026", { method: "POST" }),
    env,
  );
  assert.equal(denied.status, 401);
  assert.equal(calls.length, 0);
  const allowed = await worker.fetch(
    new Request("https://runtime.example/internal/teams/frc3461/refresh?year=2026", {
      method: "POST", headers: { Authorization: "Bearer server-only-token" },
    }),
    env,
  );
  assert.equal(allowed.status, 200);
  assert.deepEqual(calls, [
    { operation: "id", name: "frc3461" },
    { operation: "fetch", id: "frc3461", path: "/refresh", method: "POST" },
  ]);
});


test("public event analytics route exposes the persisted analytics publication", async () => {
  const { env, calls } = makeEnvironment();
  const response = await worker.fetch(
    new Request("https://runtime.example/events/2026test/analytics"),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Access-Control-Expose-Headers"), "X-FieldView-Snapshot-Version, X-FieldView-Analytics-Version");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await response.json()).ok, true);
  const forwarded = calls.find((call) => call.operation === "fetch");
  assert.equal(forwarded.url, "/analytics");
  assert.equal(forwarded.method, "GET");
  assert.equal(forwarded.headers.get("X-FieldView-Event-Key"), "2026test");
});


test("public team season analytics aggregates canonical TeamRuntime and EventRuntime snapshots", async () => {
  const calls = [];
  const env = {
    RUNTIME_ADMIN_TOKEN: "server-only-token",
    EVENT_SCHEDULER: {
      idFromName(name) { return name; },
      get(id) {
        return { async fetch(request) {
          calls.push({ kind: "register", id, body: await request.json() });
          return Response.json({ registered: true });
        } };
      },
    },
    TEAM_RUNTIME: {
      idFromName(name) { calls.push({ kind: "team-id", name }); return name; },
      get(id) {
        return { async fetch(request) {
          calls.push({ kind: "team", id, path: new URL(request.url).pathname + new URL(request.url).search });
          return Response.json({
            events: [
              { key: "2026alpha", name: "Alpha", event_code: "alpha", start_date: "2026-03-01", event_type: 0 },
              { key: "2026broken", name: "Broken", start_date: "2026-04-01", event_type: 0 },
              { key: "2026offseason", name: "Offseason", start_date: "2026-10-01", event_type: 99 },
            ],
          });
        } };
      },
    },
    EVENT_RUNTIME: {
      idFromName(name) { calls.push({ kind: "event-id", name }); return name; },
      get(id) {
        return { async fetch(request) {
          calls.push({ kind: "event", id, path: new URL(request.url).pathname });
          if (id === "2026broken") throw new Error("simulated event runtime failure");
          return Response.json({
            event: { name: "Alpha Event", short_name: "Alpha", start_date: "2026-03-01" },
            team_states: [{
              team_key: "frc3461",
              analytics: {
                performance: { completed_matches: 2, matches_seen: 3 },
                match_evidence: [],
              },
            }],
          });
        } };
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://runtime.example/teams/frc3461/analytics?year=2026"),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  const result = await response.json();
  assert.equal(result.team, 3461);
  assert.equal(result.year, 2026);
  assert.equal(result.eventCount, 2);
  assert.equal(result.analyzedEventCount, 1);
  assert.equal(result.matchCount, 2);
  assert.equal(result.matchesSeen, 3);
  assert.equal(result.events[0].event.name, "Alpha Event");
  assert.equal(result.events[0].status, "ready");
  assert.equal(result.events[1].status, "unavailable");
  assert.equal(result.collection.state, "partial");
  assert.ok(calls.some((call) => call.kind === "team" && call.path === "/snapshot?year=2026"));
  assert.ok(calls.some((call) => call.kind === "event" && call.id === "2026alpha"));
  assert.equal(calls.some((call) => call.kind === "event" && call.id === "2026offseason"), false);
  assert.ok(calls.some((call) => call.kind === "event" && call.id === "2026broken"));
});

test("public team analytics rejects invalid seasons before accessing runtimes", async () => {
  const response = await worker.fetch(
    new Request("https://runtime.example/teams/frc3461/analytics?year=1800"),
    { RUNTIME_ADMIN_TOKEN: "server-only-token" },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid season year" });
});
