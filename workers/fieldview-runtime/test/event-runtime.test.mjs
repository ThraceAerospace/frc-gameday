import assert from "node:assert/strict";
import test from "node:test";
import { EventRuntime, eventResourceEndpoints } from "../src/event-runtime.ts";
import { STATBOTICS_ENDPOINTS } from "../../../packages/providers/statbotics/src/endpoints.ts";
import { TBA_ENDPOINTS } from "../../../packages/providers/tba/src/endpoints.ts";

class MemoryStorage {
  values = new Map();
  alarmAt = null;
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async list({ prefix = "" } = {}) {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)));
  }
  async delete(key) { return this.values.delete(key); }
  async setAlarm(value) { this.alarmAt = Number(value); }
  async deleteAlarm() { this.alarmAt = null; }
  async transaction(callback) { return callback(this); }
}

test("EventRuntime persists endpoint validators, source versions, and webhook patches", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026test";
  const endpoint = eventResourceEndpoints(eventKey).find((path) => path.endsWith("/matches"));
  const providerMatches = [
    { key: "2026test_qm1", event_key: eventKey, alliances: { red: { score: 100 }, blue: { score: 90 } } },
  ];
  const calls = [];
  const env = {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    fetcher: async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return Response.json(providerMatches, {
        headers: { "Cache-Control": "max-age=60", ETag: '"matches-v1"' },
      });
    },
  };
  const runtime = new EventRuntime({ storage }, env, eventKey);
  await runtime.schedulePolls([endpoint], 60_000, Date.now() - 1);
  assert.ok(storage.alarmAt !== null);
  await runtime.alarm();

  const key = "endpoint:" + endpoint;
  const initial = storage.values.get(key);
  assert.deepEqual(initial.providerData, providerMatches);
  assert.deepEqual(initial.data, providerMatches);
  assert.equal(initial.etag, '"matches-v1"');
  assert.deepEqual(storage.values.get("source:" + endpoint + ":v1").data, providerMatches);
  assert.equal(storage.values.get("source:" + endpoint + ":v1").etag, '"matches-v1"');
  assert.equal(calls.length, 1);

  const webhook = {
    message_type: "match_score",
    message_data: {
      event_key: eventKey,
      match: {
        key: "2026test_qm1",
        event_key: eventKey,
        actual_time: 123,
        alliances: { red: { score: 120 }, blue: { score: 90 } },
      },
    },
  };
  const rawPayload = JSON.stringify(webhook);
  const webhookId = "a".repeat(64);
  const makeRequest = () => new Request("https://event-runtime/webhook", {
    method: "POST",
    headers: {
      Authorization: "Bearer runtime-token",
      "X-FieldView-Event-Key": eventKey,
      "X-FieldView-Webhook-Id": webhookId,
    },
    body: rawPayload,
  });

  const accepted = await runtime.fetch(makeRequest());
  assert.equal(accepted.status, 200);
  const updated = storage.values.get(key);
  assert.equal(updated.data[0].actual_time, 123);
  assert.deepEqual(updated.providerData, providerMatches);
  assert.equal(updated.etag, '"matches-v1"');
  assert.equal(updated.lastWebhookAt !== null, true);
  assert.equal(storage.values.get("snapshot-revision"), 2);
  assert.equal(storage.values.get("webhook:" + webhookId).rawPayload, rawPayload);

  const duplicate = await runtime.fetch(makeRequest());
  assert.deepEqual(await duplicate.json(), { accepted: true, duplicate: true });
  assert.equal(storage.values.get(key).revision, updated.revision);
});

test("GET snapshot composes canonical event-team domain objects with source metadata", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026test";
  const endpoints = eventResourceEndpoints(eventKey);
  const now = Date.now();
  const save = (endpoint, data) => storage.values.set("endpoint:" + endpoint, {
    endpoint,
    status: "available",
    data,
    providerData: data,
    etag: '"v1"',
    lastFetchedAt: now,
    expiresAt: now + 60_000,
    revision: 1,
    validatorRevision: 1,
    lastAttemptAt: now,
    lastWebhookAt: null,
  });
  save(endpoints[0], { key: eventKey, name: "Test Event", timezone: "America/New_York" });
  save(endpoints[1], [{ key: "frc3461", team_number: 3461, nickname: "PEACCE" }]);
  save(endpoints[2], { frc3461: null });
  save(endpoints[3], [{
    key: "2026test_qm1",
    event_key: eventKey,
    comp_level: "qm",
    set_number: 1,
    match_number: 1,
    alliances: {
      red: { team_keys: ["frc3461"], score: -1 },
      blue: { team_keys: [], score: -1 },
    },
  }]);
  save(endpoints[4], []);
  save(endpoints[5], {
    oprs: { frc3461: 0 }, dprs: { frc3461: 0 }, ccwms: { frc3461: 0 },
  });
  save(endpoints[6], {
    "2026test_qm1": { winning_alliance: "red", red: { score: 100 }, blue: { score: 90 } },
  });
  const statboticsEndpoint = STATBOTICS_ENDPOINTS.matches({ event: eventKey }, 1000, 0);
  save(statboticsEndpoint, [{ key: "2026test_qm1", pred: { red_score: 105, blue_score: 95, red_win_prob: 0.6 }, pre_epas: { "3461": { epa: 100 } }, epas: { "3461": { epa: 110 } } }]);

  const env = {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    fetcher: async () => new Response("unused"),
  };
  const runtime = new EventRuntime({ storage }, env, eventKey);
  const response = await runtime.fetch(new Request("https://event-runtime/snapshot", {
    headers: { "X-FieldView-Event-Key": eventKey },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-FieldView-Snapshot-Version"), "0");
  const snapshot = await response.json();
  assert.equal(snapshot.event.key, eventKey);
  assert.equal(snapshot.teams[0].team_number, 3461);
  assert.equal(snapshot.event_teams[0].tba_status, null);
  assert.equal(snapshot.event_teams[0].opr, 0);
  assert.equal(snapshot.event_teams[0].dpr, 0);
  assert.equal(snapshot.matches[0].key, "2026test_qm1");
  assert.equal(snapshot.matches[0].teams.red[0].team_number, 3461);
  assert.equal(snapshot.matches[0].predictions.tba.winning_alliance, "red");
  assert.equal(snapshot.matches[0].predictions.statbotics.red_score, 105);
  assert.equal(snapshot.matches[0].teams.red[0].pre_epa.epa, 100);
  assert.equal(snapshot.matches[0].teams.red[0].epa.epa, 110);
  assert.equal(snapshot.matches[0].sources.statbotics_match.status, "available");
  assert.equal(snapshot.matches[0].playoff_alliances, null);
  assert.deepEqual(snapshot.playoff_alliances, []);
  assert.equal(snapshot.sources.matches.tba_match.status, "available");
  assert.equal(snapshot.event.sources.tba_event.status, "available");
  assert.equal(snapshot.event_teams[0].sources.tba_event_oprs.validator, '"v1"');

  const eventState = storage.values.get("endpoint:" + endpoints[0]);
  eventState.expiresAt = now - 1;
  storage.values.set("endpoint:" + endpoints[0], eventState);
  const statusState = storage.values.get("endpoint:" + endpoints[2]);
  statusState.status = "unavailable";
  statusState.data = null;
  statusState.providerData = null;
  statusState.etag = null;
  statusState.lastFetchedAt = null;
  statusState.lastAttemptAt = now;
  storage.values.set("endpoint:" + endpoints[2], statusState);

  const refreshed = await runtime.fetch(new Request("https://event-runtime/snapshot", {
    headers: { "X-FieldView-Event-Key": eventKey },
  }));
  const refreshedSnapshot = await refreshed.json();
  assert.equal(refreshedSnapshot.sources.event.tba_event.status, "stale");
  assert.equal(refreshedSnapshot.sources.event_teams.tba_team_event_status.status, "unavailable");
  assert.equal(refreshedSnapshot.sources.event_teams.tba_team_event_status.retrieved_at, null);
  assert.equal("tba_status" in refreshedSnapshot.event_teams[0], false);
});


test("Statbotics refresh is a one-shot triggered by changed TBA REST representation", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026test";
  const endpoint = STATBOTICS_ENDPOINTS.matches({ event: eventKey }, 1000, 0);
  const records = [{
    key: "2026test_qm1",
    pred: { red_score: 105, blue_score: 95, red_win_prob: 0.6 },
    pre_epas: { "3461": { epa: 100 } },
    epas: { "3461": { epa: 110 } },
  }];
  const calls = [];
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    STATBOTICS_REFRESH_DELAY_MS: 0,
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    fetcher: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init.headers) });
      if (String(url).includes("api.statbotics")) {
        return Response.json(records, { headers: { "Cache-Control": "max-age=30", ETag: '"statbotics-v1"' } });
      }
      return Response.json([{ key: "2026test_qm1", event_key: eventKey, alliances: { red: { score: 10 }, blue: { score: 9 } } }], {
        headers: { "Cache-Control": "max-age=30", ETag: '"tba-matches-v1"' },
      });
    },
  }, eventKey);

  assert.equal(eventResourceEndpoints(eventKey).includes(endpoint), false);
  const tbaMatchesEndpoint = TBA_ENDPOINTS.eventMatches(eventKey);
  await runtime.schedulePolls([tbaMatchesEndpoint], 60_000, Date.now() - 1);
  await runtime.alarm();

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /thebluealliance\.com/);
  assert.ok(storage.alarmAt !== null);
  await runtime.alarm();

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://api.statbotics.io/v3" + endpoint);
  assert.equal(calls[1].headers.get("If-None-Match"), null);
  const state = storage.values.get("endpoint:" + endpoint);
  assert.deepEqual(state.data, records);
  assert.deepEqual(state.providerData, records);
  assert.equal(state.etag, '"statbotics-v1"');
  assert.deepEqual(storage.values.get("source:" + endpoint + ":v1").data, records);
  assert.equal(storage.values.has("task:" + endpoint), false);
  await runtime.alarm();
  assert.equal(calls.length, 2);
});

test("Statbotics one-shot refresh retries provider failures within a finite TBA-triggered budget", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026test";
  const endpoint = STATBOTICS_ENDPOINTS.matches({ event: eventKey }, 1000, 0);
  const calls = [];
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    STATBOTICS_REFRESH_DELAY_MS: 0,
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    fetcher: async (url) => {
      calls.push(String(url));
      if (String(url).includes("api.statbotics")) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return Response.json([{ key: "2026test_qm1", event_key: eventKey }], {
        headers: { ETag: '"tba-v1"' },
      });
    },
  }, eventKey);

  await runtime.schedulePolls([TBA_ENDPOINTS.eventMatches(eventKey)], 60_000, Date.now() - 1);
  await runtime.alarm();
  assert.equal(calls.length, 1);
  const taskKey = "task:" + endpoint;
  assert.ok(storage.values.has(taskKey));
  // Advance only the durable retry deadline; the test does not wait for backoff.
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    const task = storage.values.get(taskKey);
    assert.ok(task);
    task.dueAt = Date.now() - 1;
    storage.values.set(taskKey, task);
    await runtime.alarm();
    assert.equal(calls.length, attempt);
    assert.equal(storage.values.has(taskKey), attempt < 5);
  }
  assert.equal(storage.values.has(taskKey), false);
  assert.equal(calls.length, 5);
  await runtime.alarm();
  assert.equal(calls.length, 5);
});



test("Statbotics 304 responses retry without replacing the last good representation", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026test";
  const endpoint = STATBOTICS_ENDPOINTS.matches({ event: eventKey }, 1000, 0);
  const lastGood = [{ key: "2026test_qm1", marker: "last-good" }];
  storage.values.set("endpoint:" + endpoint, {
    endpoint,
    status: "available",
    data: lastGood,
    providerData: lastGood,
    etag: '"statbotics-v1"',
    lastFetchedAt: Date.now(),
    expiresAt: null,
    revision: 1,
    validatorRevision: 1,
    lastAttemptAt: Date.now(),
    lastWebhookAt: null,
  });
  const calls = [];
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    STATBOTICS_REFRESH_DELAY_MS: 0,
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    fetcher: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init.headers) });
      if (String(url).includes("api.statbotics.io")) {
        return new Response(null, { status: 304, headers: { ETag: '"statbotics-v1"' } });
      }
      return Response.json([{ key: "2026test_qm1", event_key: eventKey, changed: true }], {
        headers: { ETag: '"tba-v2"' },
      });
    },
  }, eventKey);

  await runtime.schedulePolls([TBA_ENDPOINTS.eventMatches(eventKey)], 60_000, Date.now() - 1);
  await runtime.alarm();
  const taskKey = "task:" + endpoint;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const task = storage.values.get(taskKey);
    assert.ok(task);
    task.dueAt = Date.now() - 1;
    storage.values.set(taskKey, task);
    await runtime.alarm();
    assert.equal(calls.length, attempt + 1);
    assert.equal(calls[attempt].headers.get("If-None-Match"), '"statbotics-v1"');
    assert.equal(storage.values.has(taskKey), attempt < 4);
  }
  assert.deepEqual(storage.values.get("endpoint:" + endpoint).data, lastGood);
});

test("versioned WebSocket subscriptions announce gaps and publish snapshot revisions", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026test";
  const endpoint = TBA_ENDPOINTS.eventMatches(eventKey);
  const acceptedSockets = [];
  class FakeSocket { sent = []; closed = false; send(message) { this.sent.push(message); } close() { this.closed = true; } }
  const clientSocket = new FakeSocket();
  const serverSocket = new FakeSocket();
  const state = { storage, acceptWebSocket(socket) { acceptedSockets.push(socket); }, getWebSockets() { return acceptedSockets; } };
  const runtime = new EventRuntime(state, {
    TBA_API_KEY: "test-api-key", TBA_WEBHOOK_SECRET: "test-webhook-secret", RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    webSocketPairFactory: () => [clientSocket, serverSocket],
    webSocketResponseFactory: () => new Response(null, { status: 200 }),
    fetcher: async () => Response.json([{ key: "2026test_qm1", event_key: eventKey, alliances: { red: { score: 10 }, blue: { score: 9 } } }], { headers: { ETag: '"matches-v1"' } }),
  }, eventKey);
  const response = await runtime.fetch(new Request("https://event-runtime/stream?since=0", { headers: { Authorization: "Bearer runtime-token", "X-FieldView-Event-Key": eventKey, Upgrade: "websocket" } }));
  assert.equal(response.status, 200);
  assert.equal(acceptedSockets.length, 1);
  assert.deepEqual(JSON.parse(serverSocket.sent[0]), { type: "connected", event_key: eventKey, version: 0, snapshot_required: false });
  await runtime.schedulePolls([endpoint], 60_000, Date.now() - 1);
  await runtime.alarm();
  assert.deepEqual(JSON.parse(serverSocket.sent[1]), { type: "snapshot.changed", event_key: eventKey, version: 1 });
  runtime.webSocketMessage(serverSocket, "ping");
  assert.equal(serverSocket.sent[2], "pong");
});

test("recurring schedules reject Statbotics endpoints even when called below the HTTP route", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026test";
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    fetcher: async () => new Response("unused"),
  }, eventKey);
  const statboticsEndpoint = STATBOTICS_ENDPOINTS.matches({ event: eventKey }, 1000, 0);
  await assert.rejects(
    runtime.schedulePolls([statboticsEndpoint], 60_000),
    /Only TBA event endpoints can be scheduled for recurring polling/,
  );
  assert.equal(storage.values.has("task:" + statboticsEndpoint), false);
});


test("public snapshot and stream reads need no user credential while state inspection remains private", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026test";
  const acceptedSockets = [];
  class FakeSocket { sent = []; send(message) { this.sent.push(message); } close() {} }
  const clientSocket = new FakeSocket();
  const serverSocket = new FakeSocket();
  const runtime = new EventRuntime({
    storage,
    acceptWebSocket(socket) { acceptedSockets.push(socket); },
    getWebSockets() { return acceptedSockets; },
  }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    webSocketPairFactory: () => [clientSocket, serverSocket],
    webSocketResponseFactory: () => new Response(null, { status: 200 }),
    fetcher: async () => new Response("unused"),
  }, eventKey);

  const snapshot = await runtime.fetch(new Request("https://event-runtime/snapshot", {
    headers: { "X-FieldView-Event-Key": eventKey },
  }));
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.headers.get("X-FieldView-Snapshot-Version"), "0");

  const stream = await runtime.fetch(new Request("https://event-runtime/stream", {
    headers: { "X-FieldView-Event-Key": eventKey, Upgrade: "websocket" },
  }));
  assert.equal(stream.status, 200);
  assert.equal(acceptedSockets.length, 1);
  assert.equal(JSON.parse(serverSocket.sent[0]).snapshot_required, true);

  const state = await runtime.fetch(new Request("https://event-runtime/state", {
    headers: { "X-FieldView-Event-Key": eventKey },
  }));
  assert.equal(state.status, 401);
  const authorizedState = await runtime.fetch(new Request("https://event-runtime/state", {
    headers: { Authorization: "Bearer runtime-token", "X-FieldView-Event-Key": eventKey },
  }));
  assert.equal(authorizedState.status, 200);
  const diagnostics = await authorizedState.json();
  assert.deepEqual(diagnostics.polling, []);
  assert.deepEqual(diagnostics.lifecycle, { completed_until: null });

  const schedule = await runtime.fetch(new Request("https://event-runtime/schedule", {
    method: "POST",
    headers: { "X-FieldView-Event-Key": eventKey, "Content-Type": "application/json" },
    body: JSON.stringify({ endpoints: [], intervalMs: 60_000 }),
  }));
  assert.equal(schedule.status, 401);
});


test("EventRuntime publishes revisions to the shared multiplexer only while registered", async () => {
  const storage = new MemoryStorage();
  const deliveries = [];
  const eventKey = "2026test";
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    MULTIPLEXER: {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (request) => {
          deliveries.push({ id, authorization: request.headers.get("Authorization"), body: await request.json() });
          return Response.json({ delivered: 1 });
        },
      }),
    },
    fetcher: async () => new Response("unused"),
  }, eventKey);

  const subscriptionRequest = (action) => new Request("https://event-runtime/subscriptions", {
    method: "POST",
    headers: {
      Authorization: "Bearer runtime-token",
      "X-FieldView-Event-Key": eventKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action }),
  });
  const subscribed = await runtime.fetch(subscriptionRequest("subscribe"));
  assert.deepEqual(await subscribed.json(), { registered: true, event_key: eventKey });
  await runtime.publishSnapshotRevision(4);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].id, "shared");
  assert.equal(deliveries[0].authorization, "Bearer runtime-token");
  assert.deepEqual(deliveries[0].body, { topic: "event-state", event_key: eventKey, version: 4 });

  const unsubscribed = await runtime.fetch(subscriptionRequest("unsubscribe"));
  assert.deepEqual(await unsubscribed.json(), { registered: false, event_key: eventKey });
  await runtime.publishSnapshotRevision(5);
  assert.equal(deliveries.length, 1);
});

test("EventRuntime applies lifecycle schedules and stops recurring polling after completed retention", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026test";
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    fetcher: async () => new Response("unused"),
  }, eventKey);
  const lifecycleRequest = (lifecycle, extra = {}) => new Request("https://event-runtime/lifecycle", {
    method: "POST",
    headers: {
      Authorization: "Bearer runtime-token",
      "X-FieldView-Event-Key": eventKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      lifecycle,
      upcomingIntervalMs: 30 * 60_000,
      activeIntervalMs: 5 * 60_000,
      ...extra,
    }),
  });

  const upcoming = await runtime.fetch(lifecycleRequest("upcoming"));
  assert.equal(upcoming.status, 200);
  for (const endpoint of eventResourceEndpoints(eventKey)) {
    assert.equal(storage.values.get("task:" + endpoint).intervalMs, 30 * 60_000);
  }
  const upcomingState = await runtime.fetch(new Request("https://event-runtime/state", {
    headers: { Authorization: "Bearer runtime-token", "X-FieldView-Event-Key": eventKey },
  }));
  const upcomingDiagnostics = await upcomingState.json();
  assert.equal(upcomingDiagnostics.polling.length, eventResourceEndpoints(eventKey).length);
  assert.ok(upcomingDiagnostics.polling.every((task) => task.interval_ms === 30 * 60_000));
  assert.equal(upcomingDiagnostics.lifecycle.completed_until, null);

  const active = await runtime.fetch(lifecycleRequest("active"));
  assert.equal(active.status, 200);
  assert.equal(storage.values.get("task:" + TBA_ENDPOINTS.eventMatches(eventKey)).intervalMs, 5 * 60_000);
  assert.equal(storage.values.get("task:" + TBA_ENDPOINTS.event(eventKey)).intervalMs, 30 * 60_000);

  const completedUntil = Date.now() + 60_000;
  const completed = await runtime.fetch(lifecycleRequest("completed", { completedUntil }));
  assert.equal(completed.status, 200);
  assert.equal(await storage.get("lifecycle:completed-until"), completedUntil);

  await storage.put("lifecycle:completed-until", Date.now() - 1);
  await runtime.alarm();
  for (const endpoint of eventResourceEndpoints(eventKey)) {
    assert.equal(storage.values.has("task:" + endpoint), false);
  }
  assert.equal(await storage.get("lifecycle:completed-until"), undefined);
});

test("webhook refresh retains the 65-second one-shot authoritative TBA refetch", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026test";
  const calls = [];
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    fetcher: async (url) => {
      calls.push(String(url));
      return Response.json([], { headers: { ETag: '"matches-v1"' } });
    },
  }, eventKey);
  const endpoint = TBA_ENDPOINTS.eventMatches(eventKey);
  const receivedAt = Date.now();
  const payload = {
    message_type: "upcoming_match",
    message_data: { event_key: eventKey, match_key: "2026test_qm1" },
  };
  const response = await runtime.fetch(new Request("https://event-runtime/webhook", {
    method: "POST",
    headers: {
      Authorization: "Bearer runtime-token",
      "X-FieldView-Event-Key": eventKey,
      "X-FieldView-Webhook-Id": "b".repeat(64),
    },
    body: JSON.stringify(payload),
  }));
  assert.equal(response.status, 200);
  const taskKey = "task:" + endpoint;
  const scheduled = storage.values.get(taskKey);
  assert.ok(scheduled);
  assert.ok(scheduled.authoritativeRefetchAt >= receivedAt + 65_000);
  assert.equal(scheduled.intervalMs, null);

  await runtime.alarm();
  assert.equal(calls.length, 1);
  const afterImmediate = storage.values.get(taskKey);
  assert.equal(afterImmediate.dueAt, scheduled.authoritativeRefetchAt);
  assert.equal(afterImmediate.authoritativeRefetchAt, scheduled.authoritativeRefetchAt);

  storage.values.set(taskKey, {
    ...afterImmediate,
    dueAt: Date.now() - 1,
    authoritativeRefetchAt: Date.now() - 1,
  });
  await runtime.alarm();
  assert.equal(calls.length, 2);
  assert.equal(storage.values.has(taskKey), false);
});

test("EventRuntime ignores out-of-order multiplexer registration generations", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026test";
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    fetcher: async () => new Response("unused"),
  }, eventKey);
  const request = (action, generation) => new Request("https://event-runtime/subscriptions", {
    method: "POST",
    headers: {
      Authorization: "Bearer runtime-token",
      "X-FieldView-Event-Key": eventKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, generation }),
  });

  const latestUnsubscribe = await runtime.fetch(request("unsubscribe", 4));
  assert.deepEqual(await latestUnsubscribe.json(), {
    registered: false, event_key: eventKey, generation: 4,
  });
  const staleSubscribe = await runtime.fetch(request("subscribe", 3));
  assert.deepEqual(await staleSubscribe.json(), {
    registered: false, event_key: eventKey, generation: 4, stale: true,
  });
  assert.equal(await storage.get("multiplexer:shared"), false);

  const latestSubscribe = await runtime.fetch(request("subscribe", 5));
  assert.deepEqual(await latestSubscribe.json(), {
    registered: true, event_key: eventKey, generation: 5,
  });
  const staleUnsubscribe = await runtime.fetch(request("unsubscribe", 4));
  assert.deepEqual(await staleUnsubscribe.json(), {
    registered: true, event_key: eventKey, generation: 5, stale: true,
  });
  assert.equal(await storage.get("multiplexer:shared"), true);
});
