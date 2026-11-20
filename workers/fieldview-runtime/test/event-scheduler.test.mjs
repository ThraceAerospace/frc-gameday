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
      const requestUrl = String(url);
      tbaRequests.push(requestUrl);
      const year = Number(requestUrl.split("/").pop());
      if (requestUrl.includes("/teams/")) {
        return Response.json([{ key: "frc3461", team_number: 3461, nickname: "Operation PEACCE Robotics" }], {
          headers: { ETag: '"teams-' + year + '"' },
        });
      }
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

  assert.equal(tbaRequests.length, 2);
  assert.ok(tbaRequests.some((url) => url.includes("/events/" + currentYear)));
  assert.ok(tbaRequests.some((url) => url.includes("/teams/" + currentYear)));
  assert.match(tbaRequests[0], new RegExp("/events/" + currentYear + "$"));
  assert.equal(lifecycleRequests.length, 1);
  assert.equal(lifecycleRequests[0].id, "2026future");
  assert.equal(lifecycleRequests[0].body.lifecycle, "upcoming");
  assert.equal(lifecycleRequests[0].body.upcomingIntervalMs, 30 * 60_000);
  assert.equal(await storage.get("scheduler:enabled"), true);
  assert.ok(await storage.get("scheduler:last-run-at"));
  assert.equal(await storage.get("scheduler:last-error"), undefined);
  assert.ok(storage.alarmAt > Date.now());
});
 
test("current-year discovery prunes old caches and stops previously scheduled future-year events", async () => {
  const storage = new MemoryStorage();
  const year = new Date().getUTCFullYear();
  for (const oldYear of [year - 1, year + 1]) {
    await storage.put("discovery:" + oldYear, {
      etag: '"old"',
      events: [],
      updatedAt: Date.now(),
      checkedAt: Date.now(),
    });
  }
  await storage.put("discovery:" + year, {
    etag: '"current"',
    events: [],
    updatedAt: Date.now(),
    checkedAt: Date.now(),
  });
  await storage.put("scheduler:event-keys", [String(year + 1) + "future"]);

  const lifecycleRequests = [];
  const env = {
    TBA_API_KEY: "test-key",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (request) => {
          lifecycleRequests.push({ id, body: await request.json() });
          return Response.json({ lifecycle: "expired" });
        },
      }),
    },
    fetcher: async () => Response.json([], { headers: { ETag: '"current-new"' } }),
  };
  const scheduler = new EventScheduler({ storage }, env);
  await scheduler.fetch(new Request("https://scheduler/start", {
    method: "POST",
    headers: { Authorization: "Bearer runtime-token" },
  }));
  await scheduler.alarm();

  assert.deepEqual([...((await storage.list({ prefix: "discovery:" })).keys())], ["discovery:" + year]);
  assert.deepEqual(await storage.get("scheduler:event-keys"), []);
  assert.equal(lifecycleRequests.length, 1);
  assert.equal(lifecycleRequests[0].id, String(year + 1) + "future");
  assert.equal(lifecycleRequests[0].body.lifecycle, "expired");
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

test("public team discovery returns canonical team records with provenance", async () => {
  const storage = new MemoryStorage();
  const updatedAt = Date.parse("2026-01-02T03:04:05.000Z");
  await storage.put("team-discovery:2026", {
    etag: '"teams-2026"',
    pageEtags: { "0": '"teams-2026"' },
    pageCount: 1,
    teamCount: 1,
    teamKeys: ["frc3461"],
    complete: true,
    updatedAt,
    checkedAt: Date.now(),
  });
  await storage.put("team-discovery:2026:page:0", [
    { key: "frc3461", team_number: 3461, nickname: "Operation PEACCE Robotics" },
  ]);
  const scheduler = new EventScheduler({ storage }, {});
  const response = await scheduler.fetch(new Request("https://scheduler/teams?year=2026"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("ETag"), '"teams-2026"');
  const payload = await response.json();
  assert.equal(payload.year, 2026);
  assert.equal(payload.teams[0].key, "frc3461");
  assert.equal(payload.teams[0].sources.tba_teams.status, "available");
  assert.equal(payload.teams[0].sources.tba_teams.retrieved_at, "2026-01-02T03:04:05.000Z");
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
  for (const discoveryYear of [year]) {
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
          eventCalls.push({ id, path: new URL(request.url).pathname, body: await request.json() });
          return Response.json({ scheduled: true });
        },
      }),
    },
    fetcher: async (url) => {
      assert.match(String(url), /\/event\/2026rikin\/teams$/);
      return Response.json([{ key: "frc3461", team_number: 3461 }]);
    },
  };
  const scheduler = new EventScheduler({ storage }, env);
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


test("district public reads return canonical retained resources without provider acquisition", async () => {
  const storage = new MemoryStorage();
  const year = 2026;
  const now = Date.now();
  await storage.put("district-directory:" + year, {
    payload: [{ key: "2026fim", year, abbreviation: "fim", display_name: "FIRST in Michigan" }],
    etag: '"districts-v1"', retrievedAt: now, checkedAt: now, status: "available",
  });
  await storage.put("district-resource:" + year + ":2026fim:district", {
    payload: { key: "2026fim", year, abbreviation: "fim", display_name: "FIRST in Michigan" },
    etag: '"district-v1"', retrievedAt: now, checkedAt: now, status: "available",
  });
  await storage.put("district-resource:" + year + ":2026fim:teams", {
    payload: [{ key: "frc3461", team_number: 3461 }], etag: '"teams-v1"', retrievedAt: now, checkedAt: now, status: "available",
  });
  const scheduler = new EventScheduler({ storage }, {
    TBA_API_KEY: "test-key",
    fetcher: async () => { throw new Error("Public reads must not acquire provider resources"); },
  });
  const directoryResponse = await scheduler.fetch(new Request("https://scheduler/districts?year=2026"));
  assert.equal(directoryResponse.status, 200);
  const directory = await directoryResponse.json();
  assert.equal(directory.districts[0].key, "2026fim");
  assert.equal(directory.sources.tba_districts.status, "available");

  const snapshotResponse = await scheduler.fetch(new Request("https://scheduler/district?year=2026&key=2026fim"));
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.district_key, "2026fim");
  assert.equal(snapshot.teams[0].key, "frc3461");
  assert.equal(snapshot.events, undefined);
  assert.equal(snapshot.sources.tba_district_teams.status, "available");
});

test("admin district directory refresh retains TBA payload and validator", async () => {
  const storage = new MemoryStorage();
  const requests = [];
  const scheduler = new EventScheduler({ storage }, {
    TBA_API_KEY: "test-key",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    PROVIDER_REQUEST_INTERVAL_MS: 100,
    fetcher: async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) });
      return Response.json([{ key: "2026fim", year: 2026, abbreviation: "fim", display_name: "FIRST in Michigan" }], {
        headers: { ETag: '"districts-v1"' },
      });
    },
  });
  const response = await scheduler.fetch(new Request("https://scheduler/admin/district-refresh?year=2026", {
    method: "POST", headers: { Authorization: "Bearer runtime-token" },
  }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.results[0].status, "available");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /districts\/2026$/);
  const cached = await storage.get("district-directory:2026");
  assert.equal(cached.payload[0].key, "2026fim");
  assert.equal(cached.etag, '"districts-v1"');
});


test("district 304 validation retains the last-good payload", async () => {
  const storage = new MemoryStorage();
  const old = {
    payload: [{ key: "2026fim", year: 2026, abbreviation: "fim", display_name: "FIRST in Michigan" }],
    etag: '"districts-v1"', retrievedAt: Date.now() - 60_000, checkedAt: Date.now() - 60_000, status: "available",
  };
  await storage.put("district-directory:2026", old);
  let requestHeaders;
  const scheduler = new EventScheduler({ storage }, {
    TBA_API_KEY: "test-key", RUNTIME_ADMIN_TOKEN: "runtime-token", PROVIDER_REQUEST_INTERVAL_MS: 100,
    fetcher: async (_url, init) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(null, { status: 304 });
    },
  });
  const response = await scheduler.fetch(new Request("https://scheduler/admin/district-refresh?year=2026", {
    method: "POST", headers: { Authorization: "Bearer runtime-token" },
  }));
  assert.equal(response.status, 200);
  assert.equal(requestHeaders.get("If-None-Match"), '"districts-v1"');
  const cached = await storage.get("district-directory:2026");
  assert.deepEqual(cached.payload, old.payload);
  assert.equal(cached.retrievedAt, old.retrievedAt);
  assert.ok(cached.checkedAt >= old.checkedAt);
});

test("district refresh failure retains last-good payload and marks it stale", async () => {
  const storage = new MemoryStorage();
  const old = {
    payload: [{ key: "2026fim", year: 2026, abbreviation: "fim", display_name: "FIRST in Michigan" }],
    etag: '"districts-v1"', retrievedAt: Date.now() - 60_000, checkedAt: Date.now() - 60_000, status: "available",
  };
  await storage.put("district-directory:2026", old);
  const scheduler = new EventScheduler({ storage }, {
    TBA_API_KEY: "test-key", RUNTIME_ADMIN_TOKEN: "runtime-token", PROVIDER_REQUEST_INTERVAL_MS: 100,
    fetcher: async () => new Response("upstream unavailable", { status: 503 }),
  });
  const response = await scheduler.fetch(new Request("https://scheduler/admin/district-refresh?year=2026", {
    method: "POST", headers: { Authorization: "Bearer runtime-token" },
  }));
  assert.equal(response.status, 200);
  const cached = await storage.get("district-directory:2026");
  assert.deepEqual(cached.payload, old.payload);
  assert.equal(cached.status, "failed");
  const publicResponse = await scheduler.fetch(new Request("https://scheduler/districts?year=2026"));
  const directory = await publicResponse.json();
  assert.equal(directory.districts[0].key, "2026fim");
  assert.equal(directory.sources.tba_districts.status, "stale");
});


test("district 404 marks a resource unavailable without discarding its last-good payload", async () => {
  const storage = new MemoryStorage();
  const old = {
    payload: [{ key: "2026fim", year: 2026, abbreviation: "fim", display_name: "FIRST in Michigan" }],
    etag: '"districts-v1"', retrievedAt: Date.now() - 60_000, checkedAt: Date.now() - 60_000, status: "available",
  };
  await storage.put("district-directory:2026", old);
  const scheduler = new EventScheduler({ storage }, {
    TBA_API_KEY: "test-key", RUNTIME_ADMIN_TOKEN: "runtime-token", PROVIDER_REQUEST_INTERVAL_MS: 100,
    fetcher: async () => new Response("not found", { status: 404 }),
  });
  const response = await scheduler.fetch(new Request("https://scheduler/admin/district-refresh?year=2026", {
    method: "POST", headers: { Authorization: "Bearer runtime-token" },
  }));
  assert.equal(response.status, 200);
  const cached = await storage.get("district-directory:2026");
  assert.deepEqual(cached.payload, old.payload);
  assert.equal(cached.retrievedAt, old.retrievedAt);
  assert.equal(cached.status, "unavailable");
  const publicResponse = await scheduler.fetch(new Request("https://scheduler/districts?year=2026"));
  assert.equal(publicResponse.status, 200);
  const directory = await publicResponse.json();
  assert.equal(directory.districts[0].key, "2026fim");
  assert.equal(directory.sources.tba_districts.status, "stale");
});
