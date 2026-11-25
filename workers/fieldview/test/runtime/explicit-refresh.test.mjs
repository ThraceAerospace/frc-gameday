import assert from "node:assert/strict";
import test from "node:test";
import { EventRuntime, eventResourceEndpoints } from "../../src/runtime/event-runtime.ts";
import { TeamRuntime } from "../../src/runtime/team-runtime.ts";
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

const teamEnv = (fetcher) => ({
  TBA_API_KEY: "test-key",
  TBA_WEBHOOK_SECRET: "unused",
  RUNTIME_ADMIN_TOKEN: "admin",
  EVENT_RUNTIME: { idFromName: (key) => key, get: () => ({ fetch: async () => new Response() }) },
  DISCOVERY_STORE: { idFromName: (key) => key, get: () => ({ fetch: async () => Response.json({ year: 2026 }) }) },
  fetcher,
});

test("explicit EventRuntime refresh preserves endpoint validators and last-good data across 304", async () => {
  const storage = new MemoryStorage();
  const eventKey = "2026explicit";
  const endpoint = TBA_ENDPOINTS.eventMatches(eventKey);
  const calls = [];
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test-key",
    TBA_WEBHOOK_SECRET: "unused",
    RUNTIME_ADMIN_TOKEN: "admin",
    fetcher: async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push(headers.get("If-None-Match"));
      if (headers.get("If-None-Match") === '"matches-v1"') {
        return new Response(null, { status: 304, headers: { "Cache-Control": "max-age=60" } });
      }
      return Response.json([{ key: eventKey + "_qm1", event_key: eventKey }], {
        headers: { ETag: '"matches-v1"', "Cache-Control": "max-age=60" },
      });
    },
  }, eventKey);
  const refresh = () => runtime.fetch(new Request("https://event-runtime/refresh", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin",
      "X-FieldView-Event-Key": eventKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ endpoints: [endpoint] }),
  }));

  const first = await refresh();
  assert.equal(first.status, 200);
  const firstState = storage.values.get("endpoint:" + endpoint);
  assert.equal(firstState.etag, '"matches-v1"');
  assert.equal(firstState.data[0].key, eventKey + "_qm1");
  const firstRevision = firstState.revision;

  const second = await refresh();
  assert.equal(second.status, 200);
  const secondState = storage.values.get("endpoint:" + endpoint);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [null, '"matches-v1"']);
  assert.equal(secondState.revision, firstRevision);
  assert.equal(secondState.etag, '"matches-v1"');
  assert.equal(secondState.data[0].key, eventKey + "_qm1");
  assert.equal("alarmAt" in storage, false);
});

test("explicit TeamRuntime refresh normalizes numeric team IDs without alarm work", async () => {
  const storage = new MemoryStorage();
  const calls = [];
  const runtime = new TeamRuntime({ storage }, teamEnv(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/team/frc3461")) {
      return Response.json({ key: "frc3461", team_number: 3461, nickname: "PEACCE" });
    }
    return Response.json([]);
  }), "3461");
  const response = await runtime.fetch(new Request("https://team/refresh?year=2026", {
    method: "POST",
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": "3461" },
  }));
  assert.equal(response.status, 200);
  assert.ok(calls.some((url) => url.endsWith("/team/frc3461")));
  const snapshot = await runtime.fetch(new Request("https://team/snapshot?year=2026", {
    headers: { "X-FieldView-Team-Key": "3461" },
  }));
  assert.equal(snapshot.status, 200);
  const state = await snapshot.json();
  assert.equal(state.team_key, "3461");
  assert.equal(state.team.team_number, 3461);
  assert.equal(storage.values.has("manual:poll-queue"), false);
  assert.equal("alarmAt" in storage, false);
});

test("explicit TeamRuntime refresh preserves a provider's explicit null team representation", async () => {
  const storage = new MemoryStorage();
  const runtime = new TeamRuntime({ storage }, teamEnv(async (input) => {
    if (String(input).endsWith("/team/frc3461")) {
      return Response.json(null, { headers: { ETag: '"team-null"' } });
    }
    return Response.json([]);
  }), "frc3461");
  const refresh = await runtime.fetch(new Request("https://team/refresh?year=2026", {
    method: "POST",
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": "frc3461" },
  }));
  assert.equal(refresh.status, 200);
  const snapshot = await runtime.fetch(new Request("https://team/snapshot?year=2026", {
    headers: { "X-FieldView-Team-Key": "frc3461" },
  }));
  assert.equal(snapshot.status, 200);
  const state = await snapshot.json();
  assert.equal(state.team, null);
  assert.equal(state.sources.tba_team.status, "available");
  assert.equal(state.sources.tba_team.validator, '"team-null"');
  assert.equal("alarmAt" in storage, false);
});
