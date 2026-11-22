import assert from "node:assert/strict";
import test from "node:test";
import { TaskScheduler } from "../src/task-scheduler.ts";

class MemoryStorage {
  values = new Map();
  alarmAt = null;
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async list({ prefix = "" } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)));
  }
  async delete(key) { return this.values.delete(key); }
  async setAlarm(value) { this.alarmAt = Number(value); }
  async deleteAlarm() { this.alarmAt = null; }
  async transaction(callback) { return callback(this); }
}

class MemoryBucket {
  values = new Map();
  async put(key, value) { this.values.set(key, String(value)); }
  async get(key) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return { async json() { return JSON.parse(value); }, async text() { return value; } };
  }
  async list({ prefix = "" } = {}) {
    return {
      objects: [...this.values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
      truncated: false,
    };
  }
}

test("TaskScheduler queues team seed and advances cross-runtime work in alarms", async () => {
  const storage = new MemoryStorage();
  const calls = [];
  const futureDate = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const events = [
    { key: "2026past", start_date: "2000-03-01", end_date: "2000-03-02", timezone: "America/New_York" },
    { key: "2026future", start_date: futureDate, end_date: futureDate, timezone: "America/New_York" },
  ];
  const env = {
    TBA_API_KEY: "test-key",
    RUNTIME_ADMIN_TOKEN: "admin",
    TEAM_RUNTIME: {
      idFromName(name) { return name; },
      get(id) {
        return { async fetch(request) {
          const path = new URL(request.url).pathname;
          calls.push({ kind: "team", id, path });
          if (path === "/state") return Response.json({ endpoints: [
            { endpoint: "/team/frc3461/events/2026", last_fetched_at: Date.now(), status: "available" },
          ] });
          if (path === "/snapshot") return Response.json({ events });
          return Response.json({ queued: true }, { status: 202 });
        } };
      },
    },
    EVENT_RUNTIME: {
      idFromName(name) { return name; },
      get(id) {
        return { async fetch(request) {
          const body = request.method === "POST" ? await request.json() : null;
          calls.push({ kind: "event", id, path: new URL(request.url).pathname, body });
          return Response.json({ scheduled: true });
        } };
      },
    },
    fetcher: async () => new Response("unexpected provider fetch", { status: 500 }),
  };
  const scheduler = new TaskScheduler({ storage }, env);
  const response = await scheduler.fetch(new Request("https://scheduler/admin/team-seed", {
    method: "POST",
    headers: { Authorization: "Bearer admin", "Content-Type": "application/json" },
    body: JSON.stringify({ team_key: "frc3461", year: 2026 }),
  }));

  assert.equal(response.status, 202);
  assert.equal(calls.length, 0, "job submission must not wait on TeamRuntime or EventRuntime");
  assert.equal((await response.json()).stage, "seed");
  await scheduler.alarm();
  assert.deepEqual(calls.map(({ kind, path }) => ({ kind, path })), [
    { kind: "team", path: "/seed" },
    { kind: "team", path: "/state" },
  ]);
  await scheduler.alarm();
  assert.equal(calls.at(-1).path, "/snapshot");
  await scheduler.alarm();
  assert.deepEqual(calls.slice(-2).map(({ kind, id, path }) => ({ kind, id, path })), [
    { kind: "event", id: "2026past", path: "/schedule" },
    { kind: "event", id: "2026future", path: "/lifecycle" },
  ]);
  const job = await storage.get("admin:team-seed:frc3461:2026");
  assert.equal(job.status, "completed");
  assert.equal(job.scheduledEvents, 2);
  assert.deepEqual(storage.values.get("registry:teams"), ["frc3461"]);
  assert.deepEqual(storage.values.get("registry:events"), ["2026future", "2026past"]);
});

test("TaskScheduler queues event participant discovery without provider I/O in the request", async () => {
  const storage = new MemoryStorage();
  let providerCalls = 0;
  const scheduler = new TaskScheduler({ storage }, {
    TBA_API_KEY: "test-key",
    RUNTIME_ADMIN_TOKEN: "admin",
    TEAM_RUNTIME: { idFromName: (key) => key, get: () => ({ fetch: async () => Response.json({ queued: true }, { status: 202 }) }) },
    EVENT_RUNTIME: { idFromName: (key) => key, get: () => ({ fetch: async () => Response.json({ queued: true }, { status: 202 }) }) },
    fetcher: async () => { providerCalls += 1; throw new Error("provider must run in alarm"); },
  });
  const response = await scheduler.fetch(new Request("https://scheduler/admin/event-team-seed", {
    method: "POST",
    headers: { Authorization: "Bearer admin", "Content-Type": "application/json" },
    body: JSON.stringify({ event_key: "2026test", year: 2026 }),
  }));
  assert.equal(response.status, 202);
  assert.equal((await response.json()).stage, "discover");
  assert.equal(providerCalls, 0);
  assert.ok(storage.alarmAt !== null);
});

test("TaskScheduler no longer exposes manual discovery routes", async () => {
  let providerCalls = 0;
  const scheduler = new TaskScheduler({ storage: new MemoryStorage() }, {
    TBA_API_KEY: "test-key",
    RUNTIME_ADMIN_TOKEN: "admin",
    fetcher: async () => { providerCalls += 1; throw new Error("discovery belongs to fieldview-jobs"); },
  });
  const startResponse = await scheduler.fetch(new Request("https://scheduler/admin/discover-year?year=2026", {
    method: "POST",
    headers: { Authorization: "Bearer admin" },
  }));
  const statusResponse = await scheduler.fetch(new Request("https://scheduler/admin/discovery-job?year=2026", {
    headers: { Authorization: "Bearer admin" },
  }));
  assert.equal(startResponse.status, 404);
  assert.equal(statusResponse.status, 404);
  assert.equal(providerCalls, 0);
});

test("TaskScheduler protects cross-runtime seed orchestration with the admin authorization", async () => {
  const scheduler = new TaskScheduler({ storage: new MemoryStorage() }, {
    TBA_API_KEY: "test-key",
    RUNTIME_ADMIN_TOKEN: "admin",
  });
  const response = await scheduler.fetch(new Request("https://scheduler/admin/team-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ team_key: "frc3461", year: 2026 }),
  }));
  assert.equal(response.status, 401);
});

test("TaskScheduler no longer exposes coverage audit routes", async () => {
  const scheduler = new TaskScheduler({ storage: new MemoryStorage() }, {
    TBA_API_KEY: "test-key", RUNTIME_ADMIN_TOKEN: "admin",
  });
  const startResponse = await scheduler.fetch(new Request("https://scheduler/admin/coverage-audit", {
    method: "POST",
    headers: { Authorization: "Bearer admin", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start", year: 2026 }),
  }));
  const statusResponse = await scheduler.fetch(new Request("https://scheduler/admin/coverage-audit?year=2026", {
    headers: { Authorization: "Bearer admin" },
  }));
  assert.equal(startResponse.status, 404);
  assert.equal(statusResponse.status, 404);
});

test("TaskScheduler admin overview does not fan out to entity runtimes", async () => {
  const storage = new MemoryStorage();
  const discoveryBucket = new MemoryBucket();
  await discoveryBucket.put("registry/runtime-events/2026test.json", "{}");
  await storage.put("registry:teams", ["frc3461"]);
  const forbiddenNamespace = {
    idFromName(name) { return name; },
    get() {
      return { async fetch() { throw new Error("overview must not query entity runtimes"); } };
    },
  };
  const scheduler = new TaskScheduler({ storage }, {
    TBA_API_KEY: "test-key",
    RUNTIME_ADMIN_TOKEN: "admin",
    DISCOVERY_BUCKET: discoveryBucket,
    EVENT_RUNTIME: forbiddenNamespace,
    TEAM_RUNTIME: forbiddenNamespace,
  });
  const response = await scheduler.fetch(new Request("https://scheduler/admin/overview", {
    headers: { Authorization: "Bearer admin" },
  }));

  assert.equal(response.status, 200);
  const overview = await response.json();
  assert.deepEqual(overview.inventory, { events: 1, teams: 1 });
  assert.deepEqual(overview.events, []);
  assert.deepEqual(overview.teams, []);
});
