import assert from "node:assert/strict";
import test from "node:test";
import { EventRuntime, eventResourceEndpoints } from "../src/event-runtime.ts";

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
