import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyEventLifecycle,
  DEFAULT_EVENT_POLLING_POLICY,
  eventPollingPolicy,
  TaskScheduler,
} from "../src/task-scheduler.ts";
import { classifyEventThisWeek } from "../../fieldview-jobs/src/calendar.ts";

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

test("event polling policy defaults and overrides remain explicit", () => {
  assert.deepEqual(DEFAULT_EVENT_POLLING_POLICY, {
    upcomingIntervalMs: 30 * 60_000,
    activeIntervalMs: 5 * 60_000,
    completedRetentionMs: 24 * 60 * 60_000,
  });
  assert.deepEqual(eventPollingPolicy({
    EVENT_UPCOMING_INTERVAL_MS: "900000",
    EVENT_ACTIVE_INTERVAL_MS: 120000,
    EVENT_COMPLETED_RETENTION_MS: "43200000",
  }), {
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

test("event team seeding explicitly curates team history and waits for acquisition", async () => {
  const storage = new MemoryStorage();
  const historyEndpoint = "/team/frc3461/events/2026";
  let historyTriggered = false;
  let historyAcquired = false;
  const teamCalls = [];
  const eventCalls = [];
  const env = {
    TBA_API_KEY: "test-key",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    PROVIDER_REQUEST_INTERVAL_MS: "100",
    TEAM_RUNTIME: {
      idFromName: (key) => key,
      get: (id) => ({
        fetch: async (request) => {
          const url = new URL(request.url);
          teamCalls.push({ path: url.pathname, method: request.method });
          if (url.pathname === "/seed") return Response.json({ scheduled: true, attempted: true });
          if (url.pathname === "/state") {
            return Response.json({
              team_key: id,
              endpoints: [{
                endpoint: historyEndpoint,
                status: historyAcquired ? "available" : "unknown",
                last_fetched_at: historyAcquired ? Date.now() : null,
              }],
            });
          }
          if (url.pathname === "/ingest-resource") {
            const body = await request.json();
            assert.equal(body.endpoint, historyEndpoint);
            historyTriggered = true;
            return Response.json({ endpoint: historyEndpoint, queued: true, status: "pending" }, { status: 202 });
          }
          if (url.pathname === "/snapshot") {
            return Response.json({
              team_key: id,
              events: [{
                key: "2026history",
                start_date: "2026-03-01",
                end_date: "2026-03-02",
                timezone: "America/New_York",
              }],
            });
          }
          return Response.json({ error: "not found" }, { status: 404 });
        },
      }),
    },
    EVENT_RUNTIME: {
      idFromName: (key) => key,
      get: (id) => ({
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
          const body = request.method === "POST" && request.headers.get("Content-Type")?.includes("application/json")
            ? await request.json() : null;
          eventCalls.push({ id, path, body });
          if (path === "/participants") return Response.json({ ready: true, team_keys: ["frc3461"] });
          return Response.json({ scheduled: true });
        },
      }),
    },
    fetcher: async () => {
      throw new Error("TaskScheduler must not call TBA directly for event participants");
    },
  };
  const scheduler = new TaskScheduler({ storage }, env);
  const started = await scheduler.fetch(new Request("https://scheduler/admin/event-team-seed", {
    method: "POST",
    headers: { Authorization: "Bearer runtime-token", "Content-Type": "application/json" },
    body: JSON.stringify({ event_key: "2026rikin", year: 2026 }),
  }));
  assert.equal(started.status, 202);

  await scheduler.alarm();
  let job = await storage.get("admin:event-team-seed:2026rikin");
  assert.equal(job.status, "running");
  assert.equal(job.stage, "wait");
  assert.equal(job.failedTeams, 0);
  assert.equal(historyTriggered, true);
  assert.equal(eventCalls.length, 0);

  historyAcquired = true;
  job.nextDueAt = 0;
  await storage.put("admin:event-team-seed:2026rikin", job);
  await scheduler.alarm();

  job = await storage.get("admin:event-team-seed:2026rikin");
  assert.equal(job.status, "completed");
  assert.equal(job.seededTeams, 1);
  assert.equal(job.failedTeams, 0);
  assert.equal(job.historicalEventsScheduled, 1);
  assert.equal(eventCalls.length, 1);
  assert.equal(eventCalls[0].id, "2026history");
  assert.equal(eventCalls[0].body.analyticsEnabled, false);
  assert.ok(teamCalls.some((call) => call.path === "/ingest-resource" && call.method === "POST"));
});


test("weekly event classification uses inclusive date-only ranges and the event timezone", () => {
  const sundayEnd = Date.parse("2026-11-23T04:59:59.999Z"); // Sunday 23:59:59.999 in New York.
  const fridayThroughSunday = {
    start_date: "2026-11-20",
    end_date: "2026-11-22",
    timezone: "America/New_York",
  };
  const sunday = classifyEventThisWeek(fridayThroughSunday, sundayEnd);
  assert.deepEqual(
    { isThisWeek: sunday?.isThisWeek, localDate: sunday?.localDate, weekStart: sunday?.weekStart, weekEnd: sunday?.weekEnd },
    { isThisWeek: true, localDate: "2026-11-22", weekStart: "2026-11-16", weekEnd: "2026-11-22" },
  );

  const thursdayThroughSaturday = classifyEventThisWeek({
    start_date: "2026-11-19", end_date: "2026-11-21", timezone: "America/New_York",
  }, sundayEnd);
  assert.equal(thursdayThroughSaturday?.isThisWeek, true);

  const nextMonday = classifyEventThisWeek({
    start_date: "2026-11-23", end_date: "2026-11-24", timezone: "America/New_York",
  }, sundayEnd);
  assert.equal(nextMonday?.isThisWeek, false);

  const mondayMidnight = classifyEventThisWeek(fridayThroughSunday, Date.parse("2026-11-23T05:00:00.000Z"));
  assert.equal(mondayMidnight?.isThisWeek, false);
  assert.equal(classifyEventThisWeek({
    start_date: "2026-11-24", end_date: "2026-11-23", timezone: "America/New_York",
  }, sundayEnd), null);
  assert.equal(classifyEventThisWeek({
    start_date: "2026-11-20", end_date: "2026-11-22", timezone: "Not/A-Timezone",
  }, sundayEnd), null);
});

test("the same instant can belong to different calendar weeks in different event timezones", () => {
  const now = Date.parse("2026-11-23T00:30:00.000Z");
  const eventDates = { start_date: "2026-11-20", end_date: "2026-11-22" };
  const newYork = classifyEventThisWeek({ ...eventDates, timezone: "America/New_York" }, now);
  const tokyo = classifyEventThisWeek({ ...eventDates, timezone: "Asia/Tokyo" }, now);
  assert.equal(newYork?.localDate, "2026-11-22");
  assert.equal(newYork?.isThisWeek, true);
  assert.equal(tokyo?.localDate, "2026-11-23");
  assert.equal(tokyo?.isThisWeek, false);
});

