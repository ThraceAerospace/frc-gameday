import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyEventLifecycle,
  DEFAULT_EVENT_POLLING_POLICY,
  eventPollingPolicy,
  EventScheduler,
} from "../src/event-scheduler.ts";

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
        ? [{ key: "2026future", start_date: tomorrow, end_date: dayAfter, timezone: "America/New_York" }]
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
 
test("event polling policy defaults and overrides remain explicit", () => {
  assert.deepEqual(DEFAULT_EVENT_POLLING_POLICY, {
    discoveryIntervalMs: 60 * 60_000,
    upcomingIntervalMs: 30 * 60_000,
    activeIntervalMs: 5 * 60_000,
    completedRetentionMs: 24 * 60 * 60_000,
  });
  assert.deepEqual(eventPollingPolicy({
    EVENT_DISCOVERY_INTERVAL_MS: "7200000",
    EVENT_UPCOMING_INTERVAL_MS: "900000",
    EVENT_ACTIVE_INTERVAL_MS: 120000,
    EVENT_COMPLETED_RETENTION_MS: "43200000",
  }), {
    discoveryIntervalMs: 7_200_000,
    upcomingIntervalMs: 900_000,
    activeIntervalMs: 120_000,
    completedRetentionMs: 43_200_000,
  });
  assert.throws(() => eventPollingPolicy({ EVENT_ACTIVE_INTERVAL_MS: "0" }), /EVENT_ACTIVE_INTERVAL_MS/);
});

test("event lifecycle boundaries use the event IANA timezone across DST", () => {
  const event = {
    start_date: "2026-03-08",
    end_date: "2026-03-08",
    timezone: "America/New_York",
  };
  const start = Date.parse("2026-03-08T05:00:00.000Z");
  const end = Date.parse("2026-03-09T03:59:59.999Z");
  assert.equal(classifyEventLifecycle(event, start - 1, DEFAULT_EVENT_POLLING_POLICY)?.lifecycle, "upcoming");
  assert.equal(classifyEventLifecycle(event, start, DEFAULT_EVENT_POLLING_POLICY)?.lifecycle, "active");
  assert.equal(classifyEventLifecycle(event, end, DEFAULT_EVENT_POLLING_POLICY)?.lifecycle, "active");
  const completed = classifyEventLifecycle(event, end + 1, DEFAULT_EVENT_POLLING_POLICY);
  assert.equal(completed?.lifecycle, "completed");
  assert.equal(completed?.completedUntil, end + 24 * 60 * 60_000);
  assert.equal(classifyEventLifecycle(event, end + 24 * 60 * 60_000, DEFAULT_EVENT_POLLING_POLICY)?.lifecycle, "expired");
});

test("invalid event dates and timezones are not scheduled", () => {
  assert.equal(classifyEventLifecycle({
    start_date: "bad", end_date: "2026-11-19", timezone: "America/New_York",
  }, Date.now(), DEFAULT_EVENT_POLLING_POLICY), null);
  assert.equal(classifyEventLifecycle({
    start_date: "2026-11-20", end_date: "2026-11-19", timezone: "America/New_York",
  }, Date.now(), DEFAULT_EVENT_POLLING_POLICY), null);
  assert.equal(classifyEventLifecycle({
    start_date: "2026-11-17", end_date: "2026-11-19", timezone: "Not/A_Timezone",
  }, Date.now(), DEFAULT_EVENT_POLLING_POLICY), null);
});

test("public event discovery returns cached canonical events with provenance", async () => {
  const storage = new MemoryStorage();
  const updatedAt = Date.parse("2026-01-02T03:04:05.000Z");
  await storage.put("discovery:2026", {
    etag: '"events-2026"',
    updatedAt,
    checkedAt: Date.now(),
    events: [{
      key: "2026test",
      name: "Test Event",
      start_date: "2026-03-08",
      end_date: "2026-03-08",
      timezone: "America/New_York",
    }],
  });
  const scheduler = new EventScheduler({ storage }, {});
  const response = await scheduler.fetch(new Request("https://scheduler/events?year=2026"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("ETag"), '"events-2026"');
  assert.match(response.headers.get("Cache-Control") ?? "", /max-age=300/);
  const payload = await response.json();
  assert.equal(payload.year, 2026);
  assert.equal(payload.events[0].key, "2026test");
  assert.deepEqual(payload.events[0].sources.tba_event, {
    status: "available",
    retrieved_at: "2026-01-02T03:04:05.000Z",
    validator: '"events-2026"',
  });
});

test("public event discovery rejects invalid years and reports a cold cache", async () => {
  const scheduler = new EventScheduler({ storage: new MemoryStorage() }, {});
  assert.equal((await scheduler.fetch(new Request("https://scheduler/events?year=abc"))).status, 400);
  assert.equal((await scheduler.fetch(new Request("https://scheduler/events?year=2026"))).status, 503);
});

test("stale discovery cache provenance remains stale after missed validation cycles", async () => {
  const storage = new MemoryStorage();
  const old = Date.now() - 3 * 60 * 60_000;
  await storage.put("discovery:2026", {
    etag: '"events-old"',
    updatedAt: old,
    checkedAt: old,
    events: [{
      key: "2026stale",
      name: "Stale Event",
      start_date: "2026-03-08",
      end_date: "2026-03-08",
      timezone: "America/New_York",
    }],
  });
  const scheduler = new EventScheduler({ storage }, {});
  const response = await scheduler.fetch(new Request("https://scheduler/events?year=2026"));
  const payload = await response.json();
  assert.equal(payload.events[0].sources.tba_event.status, "stale");
});

test("a successful TBA 304 refreshes discovery validation time without replacing the payload version", async () => {
  const storage = new MemoryStorage();
  const year = new Date().getUTCFullYear();
  const old = Date.now() - 60 * 60_000;
  for (const discoveryYear of [year - 1, year, year + 1]) {
    await storage.put("discovery:" + discoveryYear, {
      etag: '"cached"',
      events: [],
      updatedAt: old,
      checkedAt: old,
    });
  }
  const scheduler = new EventScheduler({ storage }, {
    TBA_API_KEY: "test-key",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => Response.json({}) }) },
    fetcher: async () => new Response(null, { status: 304 }),
  });
  await scheduler.fetch(new Request("https://scheduler/start", {
    method: "POST",
    headers: { Authorization: "Bearer runtime-token" },
  }));
  await scheduler.alarm();
  const refreshed = await storage.get("discovery:" + year);
  assert.equal(refreshed.updatedAt, old);
  assert.ok(refreshed.checkedAt > old);
});
