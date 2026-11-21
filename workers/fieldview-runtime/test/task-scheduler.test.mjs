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

test("TaskScheduler orchestrates team seed across TeamRuntime and EventRuntime owners", async () => {
  const storage = new MemoryStorage();
  const calls = [];
  const events = [
    { key: "2026past", start_date: "2026-03-01", end_date: "2026-03-02", timezone: "America/New_York" },
    { key: "2026future", start_date: "2026-12-06", end_date: "2026-12-08", timezone: "America/New_York" },
  ];
  const env = {
    TBA_API_KEY: "test-key",
    RUNTIME_ADMIN_TOKEN: "admin",
    TEAM_RUNTIME: {
      idFromName(name) { return name; },
      get(id) {
        return { async fetch(request) {
          calls.push({ kind: "team", id, path: new URL(request.url).pathname });
          return Response.json({ attempted: true, snapshot: { events } });
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

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.event_seed.requested, 2);
  assert.equal(result.event_seed.attempted, 2);
  assert.deepEqual(calls.map(({ kind, id, path }) => ({ kind, id, path })), [
    { kind: "team", id: "frc3461", path: "/seed" },
    { kind: "event", id: "2026past", path: "/schedule" },
    { kind: "event", id: "2026future", path: "/lifecycle" },
  ]);
  assert.equal(calls[1].body.endpoints.length, 12);
  assert.equal(calls[1].body.intervalMs, 86_400_000);
  assert.equal(calls[2].body.lifecycle, "upcoming");
  assert.deepEqual(storage.values.get("registry:teams"), ["frc3461"]);
  assert.deepEqual(storage.values.get("registry:events"), ["2026future", "2026past"]);
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
