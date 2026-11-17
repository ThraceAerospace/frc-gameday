import assert from "node:assert/strict";
import test from "node:test";
import { EventScheduler } from "../src/event-scheduler.ts";

class MemoryStorage {
  values = new Map();
  alarmAt = null;
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { return this.values.delete(key); }
  async setAlarm(value) { this.alarmAt = Number(value); }
  async deleteAlarm() { this.alarmAt = null; }
  async list({ prefix = "" } = {}) {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)));
  }
  async transaction(callback) { return callback(this); }
}

test("global scheduler discovers yearly events and applies the lifecycle plan", async () => {
  const storage = new MemoryStorage();
  const currentYear = new Date().getUTCFullYear();
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const dayAfter = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const tbaRequests = [];
  const lifecycleRequests = [];
  const env = {
    TBA_API_KEY: "test-key",
    TBA_WEBHOOK_SECRET: "test-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (request) => {
          lifecycleRequests.push({ id, body: await request.json() });
          return Response.json({ lifecycle: "upcoming" });
        },
      }),
    },
    fetcher: async (url) => {
      tbaRequests.push(String(url));
      const year = Number(String(url).split("/").pop());
      const events = year === currentYear
        ? [{ key: "2026future", start_date: tomorrow, end_date: dayAfter }]
        : [];
      return Response.json(events, { headers: { ETag: '"events-' + year + '"' } });
    },
  };
  const scheduler = new EventScheduler({ storage }, env);
  const started = await scheduler.fetch(new Request("https://scheduler/start", {
    method: "POST",
    headers: { Authorization: "Bearer runtime-token" },
  }));
  assert.deepEqual(await started.json(), { started: true });
  await scheduler.alarm();

  assert.equal(tbaRequests.length, 3);
  assert.equal(lifecycleRequests.length, 1);
  assert.equal(lifecycleRequests[0].id, "2026future");
  assert.equal(lifecycleRequests[0].body.lifecycle, "upcoming");
  assert.equal(lifecycleRequests[0].body.upcomingIntervalMs, 30 * 60_000);
  assert.equal(await storage.get("scheduler:enabled"), true);
  assert.ok(await storage.get("scheduler:last-run-at"));
  assert.equal(await storage.get("scheduler:last-error"), undefined);
  assert.ok(storage.alarmAt > Date.now());
});
