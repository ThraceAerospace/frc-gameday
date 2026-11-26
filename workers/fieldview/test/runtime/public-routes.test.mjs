import assert from "node:assert/strict";
import test from "node:test";
import runtime from "../../src/runtime/index.ts";

// Adapt namespace-shaped fixtures to the in-process record-store test seam.
function adaptDiscoveryFixture(namespace) {
  const stub = namespace.get(namespace.idFromName("shared"));
  return {
    async get(key) {
      const response = await stub.fetch(new Request("https://discovery-store/get?key=" + encodeURIComponent(key)));
      return response.ok ? response.text() : undefined;
    },
    async put(key, value) {
      const response = await stub.fetch(new Request("https://discovery-store/put", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      }));
      if (!response.ok) throw new Error("Fixture record write failed");
    },
    async list() { return new Map(); },
    async delete() { return false; },
  };
}
const worker = {
  fetch(request, env) {
    if (env.DISCOVERY_STORE && !env.DISCOVERY_STORAGE) {
      env.DISCOVERY_STORAGE = adaptDiscoveryFixture(env.DISCOVERY_STORE);
    }
    return runtime.fetch(request, env);
  },
};

function makeEnvironment() {
  const calls = [];
  return {
    calls,
    env: {
      RUNTIME_ADMIN_TOKEN: "server-only-token",
      DISCOVERY_STORE: {
        idFromName(name) { return name; },
        get() {
          return { async fetch(request) {
            const key = new URL(request.url).searchParams.get("key") ?? "";
            return key.startsWith("registry/runtime-events/") || key.startsWith("registry/runtime-teams/")
              ? Response.json({})
              : new Response(null, { status: 404 });
          } };
        },
      },
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
      JOBS_REQUEST: async (request) => {
          calls.push({
            operation: "jobs",
            url: new URL(request.url).pathname + new URL(request.url).search,
            method: request.method,
            headers: new Headers(request.headers),
            body: request.method === "POST" ? await request.json().catch(() => null) : null,
          });
          return Response.json({ accepted: true }, { status: 202 });
      },
    },
  };
}

test("single-event readiness requires membership in the explicitly matching season directory", async () => {
  const calls = [];
  const directories = new Map([
    ["discovery/events/2026.json", { year: 2026, events: [{ key: "2026historic" }] }],
    ["discovery/events/2027.json", { year: 2027, events: [{ key: "2027current" }] }],
  ]);
  const env = {
    RUNTIME_ADMIN_TOKEN: "server-only-token",
    DISCOVERY_STORE: {
      idFromName(name) { assert.equal(name, "shared"); return name; },
      get() {
        return { async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/get") {
            const value = directories.get(url.searchParams.get("key"));
            return value ? Response.json(value) : new Response(null, { status: 404 });
          }
          if (url.pathname === "/put" && request.method === "POST") {
            calls.push({ operation: "registry", ...(await request.json()) });
            return Response.json({ stored: true });
          }
          throw new Error("Unexpected DiscoveryStore request");
        } };
      },
    },
    EVENT_RUNTIME: {
      idFromName(name) { calls.push({ operation: "id", name }); return name; },
      get(id) {
        return { async fetch(request) {
          const body = await request.json();
          calls.push({
            operation: "readiness",
            id,
            path: new URL(request.url).pathname,
            method: request.method,
            eventKey: request.headers.get("X-FieldView-Event-Key"),
            authorization: request.headers.get("Authorization"),
            body,
          });
          return Response.json({ event_key: id, refresh_at: body.refreshAt, refresh_queued: true });
        } };
      },
    },
  };

  const startedAt = Date.now();
  const response = await worker.fetch(
    new Request("https://runtime.example/internal/admin/event-readiness", {
      method: "POST",
      headers: { Authorization: "Bearer server-only-token", "Content-Type": "application/json" },
      body: JSON.stringify({ event_key: "2026historic", year: 2026 }),
    }),
    env,
  );
  const finishedAt = Date.now();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.event_key, "2026historic");
  assert.equal(result.refresh_queued, true);
  assert.ok(result.refresh_at >= startedAt);
  assert.ok(result.refresh_at <= finishedAt + 5 * 60_000);
  assert.deepEqual(calls.map((call) => call.operation), ["id", "readiness", "registry"]);
  assert.equal(calls[1].path, "/readiness");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].eventKey, "2026historic");
  assert.equal(calls[1].authorization, "Bearer server-only-token");
  assert.deepEqual(calls[2], {
    operation: "registry",
    key: "registry/runtime-events/2026historic.json",
    value: "{}",
  });
});

test("single-event readiness rejects an event found only in a different season directory", async () => {
  const runtimeCalls = [];
  const env = {
    RUNTIME_ADMIN_TOKEN: "server-only-token",
    DISCOVERY_STORE: {
      idFromName(name) { return name; },
      get() {
        return { async fetch(request) {
          const key = new URL(request.url).searchParams.get("key");
          return key === "discovery/events/2027.json"
            ? Response.json({ year: 2027, events: [{ key: "2027current" }] })
            : new Response(null, { status: 404 });
        } };
      },
    },
    EVENT_RUNTIME: {
      idFromName(name) { runtimeCalls.push(name); return name; },
      get() { throw new Error("an event outside the requested year's directory must not be activated"); },
    },
  };
  const response = await worker.fetch(
    new Request("https://runtime.example/internal/admin/event-readiness", {
      method: "POST",
      headers: { Authorization: "Bearer server-only-token", "Content-Type": "application/json" },
      body: JSON.stringify({ event_key: "2026historic", year: 2027 }),
    }),
    env,
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "Event is not present in the published directory for the requested year",
  });
  assert.deepEqual(runtimeCalls, []);
});

test("single-event readiness requires admin authorization and an explicit year", async () => {
  const { env, calls } = makeEnvironment();
  const denied = await worker.fetch(
    new Request("https://runtime.example/internal/admin/event-readiness", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_key: "2027current", year: 2027 }),
    }),
    env,
  );
  assert.equal(denied.status, 401);
  const missingYear = await worker.fetch(
    new Request("https://runtime.example/internal/admin/event-readiness", {
      method: "POST",
      headers: { Authorization: "Bearer server-only-token", "Content-Type": "application/json" },
      body: JSON.stringify({ event_key: "2027current" }),
    }),
    env,
  );
  assert.equal(missingYear.status, 400);
  assert.deepEqual(calls, []);
});

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

test("public event and team reads return 404 without activating unready runtimes", async () => {
  const calls = [];
  const env = {
    DISCOVERY_STORE: {
      idFromName(name) { assert.equal(name, "shared"); return name; },
      get() { return { async fetch() { return new Response(null, { status: 404 }); } }; },
    },
    EVENT_RUNTIME: {
      idFromName(name) { calls.push({ kind: "event-id", name }); return name; },
      get() { throw new Error("unready EventRuntime must not be activated"); },
    },
    TEAM_RUNTIME: {
      idFromName(name) { calls.push({ kind: "team-id", name }); return name; },
      get() { throw new Error("unready TeamRuntime must not be activated"); },
    },
  };
  const event = await worker.fetch(new Request("https://runtime.example/events/2026cold/snapshot"), env);
  const team = await worker.fetch(new Request("https://runtime.example/teams/frc3461/snapshot?year=2026"), env);
  assert.equal(event.status, 404);
  assert.equal(team.status, 404);
  assert.deepEqual(calls, [], "a public read must not instantiate a Durable Object before readiness creates its registry marker");
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

test("manual discovery and coverage audits are dispatched to the local Jobs module", async () => {
  const { env, calls } = makeEnvironment();
  const discovery = await worker.fetch(
    new Request("https://runtime.example/internal/admin/operations", {
      method: "POST",
      headers: { Authorization: "Bearer server-only-token", "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "system", action: "discover-year", year: 2026 }),
    }),
    env,
  );
  assert.equal(discovery.status, 202);
  const discoveryCall = calls.find((call) => call.operation === "jobs");
  assert.equal(discoveryCall.url, "/internal/admin/discover-year");
  assert.deepEqual(discoveryCall.body, { year: 2026 });
  assert.equal(discoveryCall.headers.get("Authorization"), "Bearer server-only-token");

  const audit = await worker.fetch(
    new Request("https://runtime.example/internal/admin/operations", {
      method: "POST",
      headers: { Authorization: "Bearer server-only-token", "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "system", action: "coverage-audit-start", year: 2026 }),
    }),
    env,
  );
  assert.equal(audit.status, 202);
  const auditCall = calls.filter((call) => call.operation === "jobs")[1];
  assert.equal(auditCall.url, "/internal/admin/coverage-audit");
  assert.deepEqual(auditCall.body, { action: "start", year: 2026 });
});

test("discovery job status is authenticated and forwarded to the local Jobs module", async () => {
  const { env, calls } = makeEnvironment();
  const denied = await worker.fetch(
    new Request("https://runtime.example/internal/admin/discover-year?year=2027"),
    env,
  );
  assert.equal(denied.status, 401);
  assert.equal(calls.some((call) => call.operation === "jobs"), false);

  const allowed = await worker.fetch(
    new Request("https://runtime.example/internal/admin/discover-year?year=2027", {
      headers: { Authorization: "Bearer server-only-token" },
    }),
    env,
  );
  assert.equal(allowed.status, 202);
  const forwarded = calls.find((call) => call.operation === "jobs");
  assert.equal(forwarded.url, "/internal/admin/discover-year?year=2027");
  assert.equal(forwarded.method, "GET");
  assert.equal(forwarded.headers.get("Authorization"), "Bearer server-only-token");
});

test("internal Workflow runtime-state route authenticates and reads the canonical EventRuntime state", async () => {
  const { env, calls } = makeEnvironment();
  const denied = await worker.fetch(
    new Request("https://runtime.example/internal/workflows/runtime-state?kind=event&key=2026test"),
    env,
  );
  assert.equal(denied.status, 404);
  assert.equal(calls.some((call) => call.operation === "fetch"), false);

  const allowed = await worker.fetch(
    new Request("https://runtime.example/internal/workflows/runtime-state?kind=event&key=2026test", {
      headers: { Authorization: "Bearer server-only-token" },
    }),
    env,
  );
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { ok: true });
  const forwarded = calls.find((call) => call.operation === "fetch");
  assert.equal(forwarded.url, "/state");
  assert.equal(forwarded.headers.get("Authorization"), "Bearer server-only-token");
  assert.equal(forwarded.headers.get("X-FieldView-Event-Key"), "2026test");
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



test("internal team seed dispatches directly to the canonical TeamRuntime", async () => {
  const calls = [];
  const env = {
    RUNTIME_ADMIN_TOKEN: "server-only-token",
    TEAM_RUNTIME: {
      idFromName(name) { calls.push({ operation: "team-id", name }); return name; },
      get(id) {
        return { async fetch(request) {
          calls.push({
            operation: "team-fetch",
            id,
            path: new URL(request.url).pathname + new URL(request.url).search,
            method: request.method,
            teamKey: request.headers.get("X-FieldView-Team-Key"),
          });
          return Response.json({ queued: true }, { status: 202 });
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
  assert.equal(response.status, 202);
  assert.deepEqual(calls, [
    { operation: "team-id", name: "frc3461" },
    { operation: "team-fetch", id: "frc3461", path: "/seed?year=2026", method: "POST", teamKey: "frc3461" },
  ]);
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

test("public event discovery returns 204 when the service is available but the season data is not published", async () => {
  const { env } = makeEnvironment();
  const response = await worker.fetch(
    new Request("https://runtime.example/events/discovery?year=2026"),
    env,
  );
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});


test("this-week reads return 204 when the service is available but the projection is not published", async () => {
  const { env } = makeEnvironment();
  const response = await worker.fetch(
    new Request("https://runtime.example/events/this-week"),
    env,
  );
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("public team discovery returns team keys from the published Durable Object pages", async () => {
  const documents = new Map([
    ["discovery/teams/2026.json", {
      year: 2026, generation: 1234, pageCount: 1, teamCount: 3, updatedAt: 1234, checkedAt: Date.now(),
    }],
    ["discovery/team-pages/2026/1234/0.json", ["frc1", "frc4", "frc3461"]],
  ]);
  const env = {
    DISCOVERY_STORE: {
      idFromName(name) { assert.equal(name, "shared"); return name; },
      get() {
        return { async fetch(request) {
          const url = new URL(request.url);
          assert.equal(url.pathname, "/get");
          const value = documents.get(url.searchParams.get("key"));
          return value === undefined ? new Response(null, { status: 404 }) : new Response(JSON.stringify(value));
        } };
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://runtime.example/teams/discovery?year=2026"),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.year, 2026);
  assert.deepEqual(body.team_keys, ["frc1", "frc4", "frc3461"]);
  assert.equal(body.team_count, 3);
  assert.equal("teams" in body, false);
  assert.equal(body.team_keys.every((key) => typeof key === "string"), true);
});

test("public team discovery rejects malformed published team-key pages", async () => {
  const documents = new Map([
    ["discovery/teams/2026.json", {
      year: 2026, generation: 1234, pageCount: 1, teamCount: 1, updatedAt: 1234, checkedAt: Date.now(),
    }],
    ["discovery/team-pages/2026/1234/0.json", ["frc3461", { key: "frc9999" }]],
  ]);
  const env = {
    DISCOVERY_STORE: {
      idFromName(name) { assert.equal(name, "shared"); return name; },
      get() {
        return { async fetch(request) {
          const value = documents.get(new URL(request.url).searchParams.get("key"));
          return value === undefined ? new Response(null, { status: 404 }) : Response.json(value);
        } };
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://runtime.example/teams/discovery?year=2026"),
    env,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Team discovery page 0 is invalid" });
});

test("retired internal lifecycle route is unavailable and never dispatches to a runtime", async () => {
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
  assert.equal(allowed.status, 404);
  assert.equal(calls.some((call) => call.operation === "fetch"), false);
  assert.equal(forwarded.url, "/lifecycle");
  assert.equal(forwarded.method, "POST");
  assert.equal(forwarded.headers.get("Authorization"), "Bearer server-only-token");
});


test("public team snapshot route selects the team Durable Object and forwards the season", async () => {
  const calls = [];
  const env = {
    DISCOVERY_STORE: {
      idFromName(name) { assert.equal(name, "shared"); return name; },
      get() { return { async fetch() { return Response.json({}); } }; },
    },
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


test("public team season analytics forwards to the canonical TeamRuntime endpoint", async () => {
  const calls = [];
  const payload = {
    team: 3461,
    year: 2026,
    eventCount: 2,
    analyzedEventCount: 1,
    matchCount: 2,
    matchesSeen: 3,
    events: [],
  };
  const env = {
    DISCOVERY_STORE: {
      idFromName(name) { assert.equal(name, "shared"); return name; },
      get() { return { async fetch() { return Response.json({}); } }; },
    },
    TEAM_RUNTIME: {
      idFromName(name) { calls.push({ kind: "team-id", name }); return name; },
      get(id) {
        return { async fetch(request) {
          calls.push({ kind: "team", id, path: new URL(request.url).pathname + new URL(request.url).search });
          return Response.json(payload);
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
  assert.deepEqual(await response.json(), payload);
  assert.deepEqual(calls, [
    { kind: "team-id", name: "frc3461" },
    { kind: "team", id: "frc3461", path: "/season-analytics?year=2026" },
  ]);
});
test("public team analytics rejects invalid seasons before accessing runtimes", async () => {
  const response = await worker.fetch(
    new Request("https://runtime.example/teams/frc3461/analytics?year=1800"),
    { RUNTIME_ADMIN_TOKEN: "server-only-token" },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid season year" });
});


test("public current-season route returns 204 until TBA status has been persisted", async () => {
  const { env } = makeEnvironment();
  const response = await worker.fetch(new Request("https://runtime.example/season/current"), env);
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("public current-season route returns the persisted TBA current_season value", async () => {
  const env = {
    DISCOVERY_STORE: {
      idFromName(name) { assert.equal(name, "shared"); return name; },
      get() {
        return { async fetch(request) {
          const url = new URL(request.url);
          assert.equal(url.pathname, "/get");
          assert.equal(url.searchParams.get("key"), "discovery/current-season.json");
          return Response.json({ year: 2027, checkedAt: 1795405924680 });
        } };
      },
    },
  };
  const response = await worker.fetch(new Request("https://runtime.example/season/current"), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { year: 2027, checkedAt: 1795405924680 });
});


test("daily team readiness starts its independent Workflow through the local Jobs module", async () => {
  const { env, calls } = makeEnvironment();
  const response = await worker.fetch(new Request("https://fieldview/internal/admin/daily-team-readiness", {
    method: "POST",
    headers: { Authorization: "Bearer server-only-token" },
  }), env);

  assert.equal(response.status, 202);
  assert.ok(calls.some((call) =>
    call.operation === "jobs" &&
    call.url === "/internal/admin/daily-team-readiness" &&
    call.method === "POST"));
});
