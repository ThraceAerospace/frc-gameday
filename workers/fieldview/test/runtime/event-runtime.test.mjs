import assert from "node:assert/strict";
import test from "node:test";
import { EventRuntime, eventResourceEndpoints } from "../../src/runtime/event-runtime.ts";
import { STATBOTICS_ENDPOINTS } from "../../../../packages/providers/statbotics/src/endpoints.ts";
import { TBA_ENDPOINTS } from "../../../../packages/providers/tba/src/endpoints.ts";

class MemoryStorage {
  values = new Map();

  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async list({ prefix = "" } = {}) {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)));
  }
  async delete(key) { return this.values.delete(key); }

  transactionTail = Promise.resolve();
  async transaction(callback) {
    const previous = this.transactionTail;
    let release;
    this.transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await callback(this); }
    finally { release(); }
  }
}

function seedEventPublication(storage, eventKey) {
  storage.values.set("event-key", eventKey);
  storage.values.set("event-state:publication", {
    sourceRevision: 0,
    snapshotVersion: 0,
    generatedAt: Date.now(),
    status: "partial",
    state: { event_key: eventKey, event: { key: eventKey }, teams: [], matches: [], sources: {} },
  });
}

test("EventRuntime does not register a Durable Object alarm handler", () => {
  assert.equal(EventRuntime.prototype.alarm, undefined);
});

test("EventRuntime normalizes legacy publication in memory without writing during reads", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026hydrated";
  storage.values.set("event-key", eventKey);
  storage.values.set("snapshot-revision", 4);
  storage.values.set("event-state:publication", {
    sourceRevision: 7, snapshotVersion: 4, generatedAt: Date.now(), status: "partial",
    state: {
      event_key: eventKey, event: { key: eventKey }, teams: [], matches: [], sources: {},
      analytics: { obsolete: true }, team_states: [{ team_key: "frc3461", obsolete: true }],
    },
  });
  storage.values.set("event-view:publication", {
    schema_version: 1, event_key: eventKey, version: 1, source_revision: 7,
    generated_at: Date.now(), status: "partial", team_state_revisions: [],
    storage_format: "chunked-json-v1", chunk_count: 1,
  });
  storage.values.set("event-view:publication:v1:chunk:0", "{legacy duplicate}");
  let providerCalls = 0, teamCalls = 0, activationCalls = 0;
  const runtime = new EventRuntime({
    storage,
    blockConcurrencyWhile: async (callback) => { activationCalls += 1; await callback(); },
  }, {
    TBA_API_KEY: "test-api-key", TBA_WEBHOOK_SECRET: "unused", RUNTIME_ADMIN_TOKEN: "admin",
    TEAM_RUNTIME: { idFromName: (key) => key, get: () => ({ fetch: async () => { teamCalls += 1; return Response.json({}); } }) },
    fetcher: async () => { providerCalls += 1; return Response.json([]); },
  });
  const response = await runtime.fetch(new Request("https://event-runtime/snapshot", {
    headers: { "X-FieldView-Event-Key": eventKey },
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).event.key, eventKey);
  const persistedPublication = storage.values.get("event-state:publication");
  assert.equal("analytics" in persistedPublication.state, true,
    "activation must not rewrite legacy publication records");
  assert.equal("team_states" in persistedPublication.state, true);
  assert.equal(activationCalls, 1);
  assert.equal(storage.values.has("event-view:publication"), true,
    "legacy EventView cleanup requires an explicit migration operation");
  assert.equal(storage.values.has("event-view:publication:v1:chunk:0"), true,
    "activation never deletes legacy chunks during a read");
  assert.equal(providerCalls, 0);
  assert.equal(teamCalls, 0, "event snapshot reads never fan out to TeamRuntime");
  const diagnostics = await runtime.fetch(new Request("https://event-runtime/state", {
    headers: { Authorization: "Bearer admin", "X-FieldView-Event-Key": eventKey },
  }));
  assert.equal((await diagnostics.json()).readiness.hydration, "complete");
});



test("EventRuntime republishes canonical EventState after a match-score webhook and reuses it on subsequent reads", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026publication";
  const matchesEndpoint = TBA_ENDPOINTS.eventMatches(eventKey);
  const now = Date.now();
  const initialMatch = {
    key: eventKey + "_qm1",
    event_key: eventKey,
    comp_level: "qm",
    set_number: 1,
    match_number: 1,
    alliances: {
      red: { score: 10, team_keys: ["frc1", "frc2", "frc3"] },
      blue: { score: 5, team_keys: ["frc4", "frc5", "frc6"] },
    },
  };
  storage.values.set("endpoint:" + matchesEndpoint, {
    endpoint: matchesEndpoint,
    status: "available",
    data: [initialMatch],
    providerData: [initialMatch],
    etag: '"matches-v1"',
    lastFetchedAt: now,
    expiresAt: now + 60_000,
    revision: 1,
    validatorRevision: 1,
    lastAttemptAt: now,
    lastWebhookAt: null,
  });
  storage.values.set("snapshot-revision", 1);

  let publicationWrites = 0;
  const originalPut = storage.put.bind(storage);
  storage.put = async (key, value) => {
    if (key === "event-state:publication") publicationWrites += 1;
    return originalPut(key, value);
  };

  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    fetcher: async () => new Response("unused"),
  }, eventKey);
  const snapshotRequest = (etag) => new Request("https://event-runtime/snapshot", {
    headers: {
      "X-FieldView-Event-Key": eventKey,
      ...(etag ? { "If-None-Match": etag } : {}),
    },
  });

  const initialPublicationResponse = await runtime.fetch(new Request("https://event-runtime/publish-state", {
    method: "POST",
    headers: { Authorization: "Bearer runtime-token", "X-FieldView-Event-Key": eventKey },
  }));
  assert.equal(initialPublicationResponse.status, 200);
  const initialResponse = await runtime.fetch(snapshotRequest());
  assert.equal(initialResponse.status, 200);
  assert.equal(initialResponse.headers.get("X-FieldView-Snapshot-Version"), "1");
  const initialEtag = initialResponse.headers.get("ETag");
  assert.ok(initialEtag);
  const unchangedResponse = await runtime.fetch(snapshotRequest(initialEtag));
  assert.equal(unchangedResponse.status, 304, "matching validators avoid the composed snapshot body");
  const initialPublication = storage.values.get("event-state:publication");
  assert.equal(initialPublication.snapshotVersion, 1);
  assert.equal(initialPublication.sourceRevision, 1);
  assert.equal(initialPublication.state.matches[0].alliances.red.score, 10);
  assert.equal(publicationWrites, 1);

  const webhook = {
    message_type: "match_score",
    message_data: {
      event_key: eventKey,
      match: {
        ...initialMatch,
        actual_time: 123,
        alliances: {
          red: { score: 20, team_keys: ["frc1", "frc2", "frc3"] },
          blue: { score: 5, team_keys: ["frc4", "frc5", "frc6"] },
        },
      },
    },
  };
  const webhookResponse = await runtime.fetch(new Request("https://event-runtime/webhook", {
    method: "POST",
    headers: {
      Authorization: "Bearer runtime-token",
      "X-FieldView-Event-Key": eventKey,
      "X-FieldView-Webhook-Id": "b".repeat(64),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(webhook),
  }));
  assert.equal(webhookResponse.status, 200);
  assert.deepEqual(await webhookResponse.json(), { accepted: true, duplicate: false });

  // The committed webhook update rebuilds the normalized publication before
  // broadcasting it, so subscribers receive usable FieldView data.
  const webhookPublication = storage.values.get("event-state:publication");
  assert.notEqual(webhookPublication, initialPublication);
  assert.equal(webhookPublication.snapshotVersion, 2);
  assert.equal(webhookPublication.state.matches[0].alliances.red.score, 20);
  assert.equal(publicationWrites, 2);
  assert.equal(storage.values.get("snapshot-revision"), 2);
  assert.equal(storage.values.get("endpoint:" + matchesEndpoint).revision, 2);

  const updatedResponse = await runtime.fetch(snapshotRequest());
  assert.equal(updatedResponse.status, 200);
  assert.equal(updatedResponse.headers.get("X-FieldView-Snapshot-Version"), "2");
  assert.notEqual(updatedResponse.headers.get("ETag"), initialEtag);
  const updatedSnapshot = await updatedResponse.json();
  assert.equal(updatedSnapshot.matches[0].alliances.red.score, 20);
  assert.equal(updatedSnapshot.matches[0].actual_time, 123);

  const updatedPublication = storage.values.get("event-state:publication");
  assert.equal(updatedPublication, webhookPublication);
  assert.equal(updatedPublication.snapshotVersion, 2);
  assert.equal(updatedPublication.sourceRevision, 2);
  assert.equal(updatedPublication.state.matches[0].alliances.red.score, 20);
  assert.equal(publicationWrites, 2);

  const repeatedResponse = await runtime.fetch(snapshotRequest(updatedResponse.headers.get("ETag")));
  assert.equal(repeatedResponse.status, 304);
  assert.equal(repeatedResponse.headers.get("X-FieldView-Snapshot-Version"), "2");
  assert.equal(storage.values.get("event-state:publication"), updatedPublication);
  assert.equal(publicationWrites, 2, "unchanged reads should reuse the canonical publication");
});

test("EventRuntime public snapshots return 204 until an explicit refresh publishes canonical state", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026demand";
  let providerCalls = 0, activeRequests = 0, maxConcurrentRequests = 0;
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    fetcher: async (input) => {
      providerCalls += 1;
      activeRequests += 1;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeRequests -= 1;
      const requestUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      const isEventMetadata = new URL(requestUrl).pathname.endsWith("/event/" + eventKey);
      return isEventMetadata
        ? Response.json({
          key: eventKey, name: "2026 Demand", year: 2026,
          start_date: "2026-04-01", end_date: "2026-04-03",
          timezone: "America/New_York", event_type: 0,
        })
        : Response.json([]);
    },
  }, eventKey);
  const request = () => new Request("https://event-runtime/snapshot", {
    headers: { "X-FieldView-Event-Key": eventKey },
  });

  const firstRead = await runtime.fetch(request());
  assert.equal(firstRead.status, 204, "an existing EventRuntime without EventState returns no content");
  assert.equal(await firstRead.text(), "");
  const analyticsRead = await runtime.fetch(new Request("https://event-runtime/analytics", {
    headers: { "X-FieldView-Event-Key": eventKey },
  }));
  assert.equal(analyticsRead.status, 204, "an existing EventRuntime without EventAnalytics returns no content");
  assert.equal(await analyticsRead.text(), "");

  assert.equal(providerCalls, 0, "public reads never initiate provider acquisition");
  assert.equal("alarmAt" in storage, false, "public reads do not interact with alarm storage");

  const readiness = await runtime.fetch(new Request("https://event-runtime/readiness", {
    method: "POST",
    headers: {
      Authorization: "Bearer runtime-token",
      "X-FieldView-Event-Key": eventKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  }));
  assert.equal(readiness.status, 200);
  const result = await readiness.json();
  assert.equal(result.state_valid, false);
  assert.equal(result.refresh_required, true);
  assert.equal(result.refresh_dispatched, false);
  assert.equal(storage.values.get("manual:poll-queue")?.length ?? 0, 0);
  assert.equal("alarmAt" in storage, false, "readiness does not interact with alarm storage");
  assert.equal(providerCalls, 0, "readiness inspects coverage and never fetches providers");
  assert.equal((await runtime.fetch(request())).status, 204, "an existing EventRuntime without EventState returns no content");

  const refresh = await runtime.fetch(new Request("https://event-runtime/refresh", {
    method: "POST",
    headers: { Authorization: "Bearer runtime-token", "X-FieldView-Event-Key": eventKey },
  }));
  assert.equal(refresh.status, 200);
  assert.equal(providerCalls, eventResourceEndpoints(eventKey).length + 1);
  assert.equal(maxConcurrentRequests, 1, "one EventRuntime refresh command executes provider requests sequentially");
  const published = await runtime.fetch(request());
  assert.equal(published.status, 200, "the canonical EventState becomes readable after refresh publication");
});

test("explicit EventState publication composes canonical event-team domain objects with source metadata", async () => {
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
  save(endpoints[7], {
    rankings: [{ team_key: "frc3461", rank: 1, extra_stats: [9.5] }],
    extra_stats_info: [{ name: "Total Ranking Points", precision: 2 }],
    sort_order_info: null,
  });
  save(endpoints[8], [{
    name: "Quality Award",
    award_type: 1,
    event_key: eventKey,
    recipient_list: [{ team_key: "frc3461", awardee: null }],
    year: 2026,
  }]);
  save(endpoints[11], {
    points: {
      frc3461: {
        qual_points: 4, alliance_points: 8, elim_points: 12,
        award_points: 5, total: 29,
      },
    },
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
  const publish = await runtime.fetch(new Request("https://event-runtime/publish-state", {
    method: "POST",
    headers: { Authorization: "Bearer runtime-token", "X-FieldView-Event-Key": eventKey },
  }));
  assert.equal(publish.status, 200, "an explicit runtime command creates the initial publication");
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
  assert.equal(snapshot.rankings.rankings[0].team_key, "frc3461");
  assert.equal(snapshot.awards[0].recipient_list[0].team_key, "frc3461");
  assert.equal(snapshot.advancement_points.points.frc3461.total, 29);
  assert.equal(snapshot.sources.rankings.tba_event_rankings.status, "available");
  assert.equal(snapshot.sources.awards.tba_event_awards.status, "available");
  assert.equal(snapshot.sources.advancement_points.tba_event_advancement_points.status, "available");
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
  const advancementState = storage.values.get("endpoint:" + endpoints[11]);
  advancementState.status = "unavailable";
  advancementState.data = null;
  advancementState.providerData = null;
  advancementState.etag = null;
  advancementState.lastFetchedAt = null;
  advancementState.expiresAt = null;
  advancementState.lastAttemptAt = now;
  storage.values.set("endpoint:" + endpoints[11], advancementState);

  const republish = await runtime.fetch(new Request("https://event-runtime/publish-state", {
    method: "POST",
    headers: { Authorization: "Bearer runtime-token", "X-FieldView-Event-Key": eventKey },
  }));
  assert.equal(republish.status, 200);
  const refreshed = await runtime.fetch(new Request("https://event-runtime/snapshot", {
    headers: { "X-FieldView-Event-Key": eventKey },
  }));
  const refreshedSnapshot = await refreshed.json();
  assert.equal(refreshedSnapshot.sources.event.tba_event.status, "stale");
  assert.equal(refreshedSnapshot.sources.event_teams.tba_team_event_status.status, "unavailable");
  assert.equal(refreshedSnapshot.sources.event_teams.tba_team_event_status.retrieved_at, null);
  assert.equal("tba_status" in refreshedSnapshot.event_teams[0], false);
  assert.equal("advancement_points" in refreshedSnapshot, false);
  assert.equal(refreshedSnapshot.sources.advancement_points.tba_event_advancement_points.status, "unavailable");
});



test("EventRuntime serves event-scoped Statbotics matches from its durable provider state", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026test";
  seedEventPublication(storage, eventKey);
  const endpoint = STATBOTICS_ENDPOINTS.matches({ event: eventKey }, 1000, 0);
  const records = [{
    key: "2026test_qm1",
    pred: { red_score: 105, blue_score: 95, red_win_prob: 0.6 },
  }];
  storage.values.set("endpoint:" + endpoint, {
    endpoint,
    status: "available",
    revision: 1,
    lastFetchedAt: Date.now(),
    lastWebhookAt: null,
    expiresAt: Date.now() + 60_000,
    etag: '"statbotics-v1"',
    data: records,
    providerData: records,
  });
  let providerCalls = 0;
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    fetcher: async () => { providerCalls += 1; return Response.json([]); },
  }, eventKey);
  const headers = { "X-FieldView-Event-Key": eventKey };
  const response = await runtime.fetch(new Request(
    "https://event-runtime/statbotics-match?match_key=2026test_qm1",
    { headers },
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), records[0]);
  assert.equal(providerCalls, 0, "a cached Statbotics read must not perform provider I/O");

  const mismatch = await runtime.fetch(new Request(
    "https://event-runtime/statbotics-match?match_key=2026other_qm1",
    { headers },
  ));
  assert.equal(mismatch.status, 400, "match keys cannot cross event Durable Object boundaries");
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

  seedEventPublication(storage, eventKey);
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
  assert.equal(diagnostics.polling.length, 0, "public reads do not register recurring tasks");
  assert.equal("alarmAt" in storage, false, "public reads do not interact with alarm storage");
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
  seedEventPublication(storage, eventKey);
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
  assert.deepEqual(await subscribed.json(), { registered: true, event_key: eventKey, topic: "event-state" });
  await runtime.publishSnapshotRevision(4);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].id, "shared");
  assert.equal(deliveries[0].authorization, "Bearer runtime-token");
  assert.deepEqual(deliveries[0].body, {
    protocol: 1,
    schema_version: 1,
    topic: "event-state",
    resource: "event-snapshot",
    change: "snapshot",
    event_key: eventKey,
    version: 4,
  });

  const unsubscribed = await runtime.fetch(subscriptionRequest("unsubscribe"));
  assert.deepEqual(await unsubscribed.json(), { registered: false, event_key: eventKey, topic: "event-state" });
  await runtime.publishSnapshotRevision(5);
  assert.equal(deliveries.length, 1);
});


test("EventRuntime tracks analytics multiplexer registration independently", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026test";
  seedEventPublication(storage, eventKey);
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    fetcher: async () => new Response("unused"),
  }, eventKey);
  const request = (action, generation) => new Request("https://event-runtime/subscriptions", {
    method: "POST",
    headers: {
      Authorization: "Bearer runtime-token",
      "X-FieldView-Event-Key": eventKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, topic: "analytics", generation }),
  });
  const subscribed = await runtime.fetch(request("subscribe", 1));
  assert.deepEqual(await subscribed.json(), {
    registered: true, event_key: eventKey, topic: "analytics", generation: 1,
  });
  assert.equal(await storage.get("multiplexer:analytics"), true);
  assert.equal(await storage.get("multiplexer:shared"), undefined);
  const unsubscribed = await runtime.fetch(request("unsubscribe", 2));
  assert.deepEqual(await unsubscribed.json(), {
    registered: false, event_key: eventKey, topic: "analytics", generation: 2,
  });
  assert.equal(await storage.get("multiplexer:analytics"), false);
});



test("EventRuntime ignores out-of-order multiplexer registration generations", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026test";
  seedEventPublication(storage, eventKey);
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
    registered: false, event_key: eventKey, topic: "event-state", generation: 4,
  });
  const staleSubscribe = await runtime.fetch(request("subscribe", 3));
  assert.deepEqual(await staleSubscribe.json(), {
    registered: false, event_key: eventKey, topic: "event-state", generation: 4, stale: true,
  });
  assert.equal(await storage.get("multiplexer:shared"), false);

  const latestSubscribe = await runtime.fetch(request("subscribe", 5));
  assert.deepEqual(await latestSubscribe.json(), {
    registered: true, event_key: eventKey, topic: "event-state", generation: 5,
  });
  const staleUnsubscribe = await runtime.fetch(request("unsubscribe", 4));
  assert.deepEqual(await staleUnsubscribe.json(), {
    registered: true, event_key: eventKey, topic: "event-state", generation: 5, stale: true,
  });
  assert.equal(await storage.get("multiplexer:shared"), true);
});





test("EventRuntime directly acquires participant discovery when its owned TBA resource is missing", async () => {
  const storage = new MemoryStorage(), eventKey = "2026participants";
  const endpoint = TBA_ENDPOINTS.eventTeams(eventKey);
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    fetcher: async () => Response.json(
      [{ key: "frc3461" }, { key: "frc254" }, { key: "frc3461" }],
      { headers: { ETag: '"participants-v1"', "Cache-Control": "max-age=60" } },
    ),
  }, eventKey);

  const pending = await runtime.fetch(new Request("https://event-runtime/participants", {
    method: "POST",
    headers: { Authorization: "Bearer runtime-token", "X-FieldView-Event-Key": eventKey },
  }));
  assert.equal(pending.status, 200);
  assert.equal((await pending.json()).ready, true);
  const ready = await runtime.fetch(new Request("https://event-runtime/participants", {
    method: "POST",
    headers: { Authorization: "Bearer runtime-token", "X-FieldView-Event-Key": eventKey },
  }));
  assert.equal(ready.status, 200);
  assert.deepEqual((await ready.json()).team_keys, ["frc254", "frc3461"]);
});

test("EventRuntime omits legacy embedded TeamEventStates from reads without rewriting storage", async () => {
  const storage = new MemoryStorage(), eventKey = "2026ownership";
  storage.values.set("snapshot-revision", 1);
  storage.values.set("event-state:publication", {
    sourceRevision: 0,
    snapshotVersion: 1,
    generatedAt: Date.now(),
    status: "partial",
    state: {
      event_key: eventKey,
      event: { key: eventKey },
      sources: {},
      teams: [],
      team_states: [{ event_key: eventKey, team_key: "frc3461", sources: {} }],
    },
  });
  const runtime = new EventRuntime({
    storage,
    blockConcurrencyWhile: async (callback) => callback(),
  }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response() }) },
    fetcher: async () => Response.json([]),
  }, eventKey);
  const response = await runtime.fetch(new Request("https://event-runtime/snapshot", {
    headers: { "X-FieldView-Event-Key": eventKey },
  }));
  assert.equal(response.status, 200);
  const persisted = storage.values.get("event-state:publication");
  assert.equal(Object.hasOwn(persisted.state, "team_states"), true,
    "legacy durable data remains untouched until an explicit migration");
  const composed = await response.json();
  assert.equal("team_states" in composed, false,
    "the event snapshot never embeds TeamRuntime-owned state");
});



test("event analytics never activates TeamRuntimes that independent team readiness has not registered", async () => {
  const storage = new MemoryStorage();
  let teamRuntimeActivations = 0;
  let discoveryLists = 0;
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    TEAM_RUNTIME: {
      idFromName: (key) => { teamRuntimeActivations += 1; return key; },
      get: () => ({
        fetch: async () => {
          teamRuntimeActivations += 1;
          return Response.json({});
        },
      }),
    },
    DISCOVERY_STORE: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (request) => {
          assert.equal(new URL(request.url).pathname, "/list");
          discoveryLists += 1;
          return Response.json({ objects: [], truncated: false });
        },
      }),
    },
  }, "2027independent");

  const collected = await runtime.collectEventTeamSeasonComparisonInput({
    event: {
      key: "2027independent",
      name: "Independent Readiness",
      event_code: "independent",
      start_date: "2027-01-01",
    },
    teams: [{ key: "frc3461", team_number: 3461 }],
  });

  assert.ok(collected);
  assert.equal(collected.comparisonInput.discovery_pending_teams, 1);
  assert.equal(discoveryLists, 1, "event analytics checks the independent team-runtime registry");
  assert.equal(teamRuntimeActivations, 0,
    "an unregistered TeamRuntime must not be created by EventRuntime analytics");
});


test("EventRuntime analytics skips TeamRuntimes until the independent team readiness registry contains them", async () => {
  const storage = new MemoryStorage();
  let teamRuntimeActivations = 0;
  let discoveryLists = 0;
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    TEAM_RUNTIME: {
      idFromName: (key) => { teamRuntimeActivations += 1; return key; },
      get: () => ({
        fetch: async () => {
          teamRuntimeActivations += 1;
          return Response.json({});
        },
      }),
    },
    DISCOVERY_STORE: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (request) => {
          assert.equal(new URL(request.url).pathname, "/list");
          discoveryLists += 1;
          return Response.json({ objects: [], truncated: false });
        },
      }),
    },
  }, "2027independent");

  const collected = await runtime.collectEventTeamSeasonComparisonInput({
    event: {
      key: "2027independent",
      name: "Independent Readiness",
      event_code: "independent",
      start_date: "2027-01-01",
    },
    teams: [{ key: "frc3461", team_number: 3461 }],
  });

  assert.ok(collected);
  assert.equal(collected.comparisonInput.discovery_pending_teams, 1);
  assert.equal(discoveryLists, 1, "analytics checks the TeamRuntime registry");
  assert.equal(teamRuntimeActivations, 0,
    "EventRuntime analytics must not create an unregistered TeamRuntime");
});

test("EventRuntime readiness inspects freshness without queueing provider work", async () => {
  const storage = new MemoryStorage(), eventKey = "2027rikin", now = Date.now();
  seedEventPublication(storage, eventKey);
  const endpoints = eventResourceEndpoints(eventKey);
  for (const endpoint of [...endpoints, STATBOTICS_ENDPOINTS.matches({ event: eventKey }, 1000, 0)]) {
    storage.values.set("endpoint:" + endpoint, {
      endpoint, status: "available", revision: 1, lastFetchedAt: now,
      lastWebhookAt: null, expiresAt: now + 60_000, etag: null, data: [],
    });
  }
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    fetcher: async () => { throw new Error("readiness must not fetch providers inline"); },
  }, eventKey);
  const inspect = () => runtime.fetch(new Request("https://event-runtime/readiness", {
    method: "POST",
    headers: { Authorization: "Bearer runtime-token", "X-FieldView-Event-Key": eventKey, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }));

  const fresh = await inspect();
  assert.equal(fresh.status, 200);
  const freshResult = await fresh.json();
  assert.equal(freshResult.state_valid, true);
  assert.equal(freshResult.refresh_required, false);
  assert.equal(freshResult.refresh_dispatched, false);
  assert.deepEqual(freshResult.stale_sources, []);
  assert.equal(storage.values.get("manual:poll-queue")?.length ?? 0, 0);
  assert.equal("alarmAt" in storage, false, "readiness does not interact with alarm storage");

  const staleEndpoint = endpoints[0];
  storage.values.get("endpoint:" + staleEndpoint).expiresAt = Date.now() - 1;
  const stale = await inspect();
  assert.equal(stale.status, 200);
  const staleResult = await stale.json();
  assert.equal(staleResult.state_valid, true);
  assert.equal(staleResult.refresh_required, true);
  assert.equal(staleResult.refresh_dispatched, false);
  assert.deepEqual(staleResult.stale_sources, [staleEndpoint]);
  assert.equal(storage.values.get("manual:poll-queue")?.length ?? 0, 0);
  assert.equal("alarmAt" in storage, false, "readiness does not interact with alarm storage");
  const statboticsTask = storage.values.get("task:" + STATBOTICS_ENDPOINTS.matches({ event: eventKey }, 1000, 0));
  assert.equal(statboticsTask, undefined);
});

test("EventRuntime subscriptions remain unavailable until a canonical EventState is published", async () => {
  const storage = new MemoryStorage(), eventKey = "2026firstrequest";
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    fetcher: async () => Response.json([]),
  }, eventKey);
  const response = await runtime.fetch(new Request("https://event-runtime/subscriptions", {
    method: "POST",
    headers: {
      Authorization: "Bearer runtime-token",
      "X-FieldView-Event-Key": eventKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "subscribe" }),
  }));
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "", "a missing EventState has no response body");
  assert.equal(storage.values.has("event-state:publication"), false,
    "a frontend subscription must not synthesize an empty EventState");
});


test("EventRuntime builds one shared comparison input from every roster TeamState", async () => {
  const storage = new MemoryStorage(), eventKey = "2026target";
  const teamSnapshots = new Map([
    ["frc3461", {
      team_key: "frc3461", year: 2026, team: { team_number: 3461 },
      sources: { statbotics_team_events: { status: "available", retrieved_at: "2026-03-10T12:00:00.000Z" } },
      events: [
        { key: "2026priorA", name: "Prior A", event_code: "priorA", start_date: "2026-03-01", event_type: 0 },
        { key: "2026target", name: "Target", event_code: "target", start_date: "2026-03-10", event_type: 0 },
      ],
      statbotics_events: [{
        event: "2026priorA", epa: { total_points: 20, unitless: 0.2, breakdown: { auto_epa: 5 } },
        record: { total: { wins: 3, losses: 1, ties: 0, count: 4 } },
      }, {
        event: "2026target", epa: { total_points: 25, unitless: 0.25, breakdown: { auto_epa: 6 } },
        record: { total: { wins: 1, losses: 0, ties: 0, count: 1 } },
      }],
    }],
    ["frc254", {
      team_key: "frc254", year: 2026, team: { team_number: 254 },
      sources: { statbotics_team_events: { status: "available", retrieved_at: "2026-03-10T12:00:00.000Z" } },
      events: [
        { key: "2026priorB", name: "Prior B", event_code: "priorB", start_date: "2026-03-02", event_type: 0 },
        { key: "2026target", name: "Target", event_code: "target", start_date: "2026-03-10", event_type: 0 },
      ],
      statbotics_events: [{
        event: "2026priorB", epa: { total_points: 30, unitless: 0.3, breakdown: { auto_epa: 7 } },
        record: { total: { wins: 4, losses: 0, ties: 0, count: 4 } },
      }, {
        event: "2026target", epa: { total_points: 32, unitless: 0.32, breakdown: { auto_epa: 8 } },
        record: { total: { wins: 1, losses: 0, ties: 0, count: 1 } },
      }],
    }],
  ]);
  const teamNamespace = {
    idFromName: (key) => key,
    get: (key) => ({
      fetch: async () => {
        const snapshot = teamSnapshots.get(key);
        return snapshot
          ? Response.json(snapshot, { headers: { "X-FieldView-Snapshot-Version": "2" } })
          : new Response(null, { status: 404 });
      },
    }),
  };
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    TEAM_RUNTIME: teamNamespace,
    DISCOVERY_STORE: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => Response.json({
          objects: [
            { key: "registry/runtime-teams/frc3461.json" },
            { key: "registry/runtime-teams/frc254.json" },
          ],
          truncated: false,
        }),
      }),
    },
    fetcher: async () => Response.json([]),
  }, eventKey);
  const eventState = {
    event: { key: eventKey, name: "Target", event_code: "target", start_date: "2026-03-10" },
    teams: [{ key: "frc3461", team_number: 3461 }, { key: "frc254", team_number: 254 }],
  };
  const result = await runtime.collectEventTeamSeasonComparisonInput(eventState);
  assert.ok(result);
  assert.equal(result.comparisonInput.team_count, 2);
  assert.deepEqual(
    [...new Set(result.comparisonInput.records.map((record) => record.team_number))].sort((a, b) => a - b),
    [254, 3461],
  );
  assert.ok(result.comparisonInput.records.some((record) => record.team_number === 3461 && record.event.event_key === "2026priorA"));
  assert.ok(result.comparisonInput.records.some((record) => record.team_number === 254 && record.event.event_key === "2026priorB"));
  assert.equal(result.comparisonInput.team_state_revisions.length, 2);
  assert.equal(result.comparisonInput.state, "complete");
});


test("EventRuntime composes FieldViewEventView from event state and TeamRuntime-owned TeamEventStates", async () => {
  const storage = new MemoryStorage(), eventKey = "2026fieldview", teamKey = "frc3461";
  const eventState = {
    event_key: eventKey,
    event: { key: eventKey, name: "FieldView Test", timezone: "America/New_York" },
    teams: [{ key: teamKey, team_number: 3461 }],
    sources: {},
  };
  storage.values.set("snapshot-revision", 1);
  storage.values.set("event-state:publication", {
    sourceRevision: 0,
    snapshotVersion: 1,
    generatedAt: Date.now(),
    status: "complete",
    state: eventState,
  });
  storage.values.set("team-state-revision:" + teamKey, 2);
  storage.values.set("event-team-comparison-input:updated-at", 123);
  const teamEventState = {
    event_key: eventKey,
    team_key: teamKey,
    sources: { team: {}, event_team: {}, matches: {} },
    match_refs: [],
    analytics: { event_key: eventKey, team_key: teamKey, metrics: [], findings: [] },
  };
  const teamNamespace = {
    idFromName: (key) => key,
    get: () => ({
      fetch: async () => Response.json(teamEventState, { headers: {
        "X-FieldView-Event-Source-Revision": "0",
        "X-FieldView-Team-Source-Revision": "2",
        "X-FieldView-Comparison-Input-Updated-At": "123",
        "X-FieldView-Team-Event-Revision": "4",
      } }),
    }),
  };
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    TEAM_RUNTIME: teamNamespace,
    fetcher: async () => Response.json([]),
  }, eventKey);
  const response = await runtime.fetch(new Request("https://event-runtime/view", {
    headers: { "X-FieldView-Event-Key": eventKey },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-FieldView-Team-State-Coverage"), "partial",
    "a public event view never synchronously fans out to TeamRuntime objects");
  const view = await response.json();
  assert.equal(view.event.event_key, eventKey);
  assert.equal(view.analytics, null);
  assert.deepEqual(view.team_state_refs, [{
    owner: "team-runtime", owner_id: teamKey, record_type: "team-event-state", record_id: eventKey, revision: null,
  }]);
  assert.deepEqual(view.team_state_coverage, {
    state: "partial",
    expected_count: 1,
    materialized_count: 0,
    pending_team_keys: [teamKey],
  });
  assert.equal("team_states" in view.event, false);
  assert.equal(response.headers.get("X-FieldView-Team-State-Coverage"), "partial");
});

test("EventRuntime admin state diagnostics do not fan out to TeamRuntime", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026adminstate";
  storage.values.set("event-state:publication", {
    sourceRevision: 0,
    snapshotVersion: 1,
    generatedAt: Date.now(),
    status: "complete",
    state: { event_key: eventKey, teams: [{ key: "frc3461" }] },
  });
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    TEAM_RUNTIME: {
      idFromName: (key) => key,
      get: () => ({ fetch: async () => { throw new Error("admin state must not query TeamRuntime"); } }),
    },
    fetcher: async () => Response.json([]),
  }, eventKey);

  const response = await runtime.fetch(new Request("https://event-runtime/state", {
    headers: {
      Authorization: "Bearer runtime-token",
      "X-FieldView-Event-Key": eventKey,
    },
  }));
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(state.analytics.team_state_coverage, {
    status: "not_inspected",
    expected: 1,
    materialized: null,
  });
});

test("explicit EventRuntime refresh targets only the requested Statbotics resource", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026targeted";
  const endpoint = STATBOTICS_ENDPOINTS.matches({ event: eventKey }, 1000, 0);
  const calls = [];
  seedEventPublication(storage, eventKey);
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-api-key",
    TBA_WEBHOOK_SECRET: "test-webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    fetcher: async (url) => {
      calls.push(String(url));
      return Response.json([{ key: eventKey + "_qm1" }], {
        headers: { ETag: '"statbotics-targeted-v1"' },
      });
    },
  }, eventKey);

  const response = await runtime.fetch(new Request("https://event-runtime/refresh", {
    method: "POST",
    headers: {
      Authorization: "Bearer runtime-token",
      "X-FieldView-Event-Key": eventKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ endpoints: [endpoint] }),
  }));

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.results.map((item) => item.endpoint), [endpoint]);
  assert.equal(calls.length, 1, "an explicit resource list must not refresh every TBA endpoint");
  assert.ok(calls[0].includes(endpoint));
});


test("EventRuntime accepts analytics publication only for the current event source revision", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026publication";
  storage.values.set("event-key", eventKey);
  storage.values.set("snapshot-revision", 0);
  let teamRuntimeCalls = 0;
  const runtime = new EventRuntime({ storage }, {
    RUNTIME_ADMIN_TOKEN: "admin",
    TEAM_RUNTIME: {
      idFromName: (key) => key,
      get: () => ({ fetch: async () => { teamRuntimeCalls += 1; return Response.json({}); } }),
    },
  }, eventKey);

  const response = await runtime.fetch(new Request("https://event-runtime/analytics-orchestration-publication", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin",
      "X-FieldView-Event-Key": eventKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contract_version: 1,
      event_key: eventKey,
      event_source_revision: 1,
      recalculated_team_keys: [],
      team_results: [],
    }),
  }));

  assert.equal(response.status, 409);
  assert.equal(teamRuntimeCalls, 0, "the Workflow publication endpoint must not call TeamRuntime");
  assert.equal(storage.values.has("analytics:publication"), false);
  assert.equal(storage.values.has("analytics:status"), false,
    "a stale publication command is a conflict, not a failed analytics calculation");
});

