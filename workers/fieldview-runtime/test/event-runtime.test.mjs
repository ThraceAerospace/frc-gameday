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
    headers: {
      Authorization: "Bearer runtime-token",
      "X-FieldView-Event-Key": eventKey,
    },
  }));
  assert.equal(response.status, 200);
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
    headers: {
      Authorization: "Bearer runtime-token",
      "X-FieldView-Event-Key": eventKey,
    },
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
      if (String(url).includes("api-statbotics")) {
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
  assert.equal(calls[1].url, "https://api-statbotics.iterativerefinement.com/v3" + endpoint);
  assert.equal(calls[1].headers.get("If-None-Match"), null);
  const state = storage.values.get("endpoint:" + endpoint);
  assert.deepEqual(state.data, records);
  assert.deepEqual(state.providerData, records);
  assert.equal(state.etag, '"statbotics-v1"');
  assert.deepEqual(storage.values.get("source:" + endpoint + ":v1").data, records);
  assert.equal(storage.values.has("poll:" + endpoint), false);
});

test("Statbotics one-shot refresh does not retry a failed provider request", async () => {
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
      if (String(url).includes("api-statbotics")) {
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
  assert.ok(storage.values.has("poll:" + endpoint));
  await runtime.alarm();
  assert.equal(calls.length, 2);
  assert.match(calls[1], /api-statbotics/);
  assert.equal(storage.values.has("poll:" + endpoint), false);
});
