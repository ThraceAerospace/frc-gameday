import assert from "node:assert/strict";
import test from "node:test";
import { EventRuntime, eventResourceEndpoints } from "../../src/runtime/event-runtime.ts";
import { TeamRuntime, teamResourceEndpoints } from "../../src/runtime/team-runtime.ts";
import { STATBOTICS_ENDPOINTS } from "../../../../packages/providers/statbotics/src/endpoints.ts";
import { createEndpointState } from "../../src/runtime/endpoint-state.ts";

class MemoryStorage {
  values = new Map();
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async list({ prefix = "" } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)));
  }
  async delete(key) { return this.values.delete(key); }
  tail = Promise.resolve();
  async transaction(callback) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await callback(this); }
    finally { release(); }
  }
}

function resource(endpoint, data, acquiredAt) {
  return {
    ...createEndpointState(endpoint),
    status: "available",
    data,
    providerData: data,
    etag: null,
    lastFetchedAt: acquiredAt,
    expiresAt: null,
    revision: 1,
    validatorRevision: 1,
    lastAttemptAt: acquiredAt,
  };
}

const adminHeaders = (identityHeader, key) => ({
  Authorization: "Bearer admin",
  "Content-Type": "application/json",
  [identityHeader]: key,
});

test("EventRuntime accepts and idempotently republishes a workflow bootstrap", async () => {
  const key = "2027boot";
  const acquiredAt = Date.now();
  const storage = new MemoryStorage();
  const eventEndpoint = eventResourceEndpoints(key)[0];
  const event = {
    key, name: "Bootstrap Test", year: 2027,
    start_date: "2027-04-01", end_date: "2027-04-03",
    timezone: "America/New_York", event_type: 0,
  };
  const endpoints = [
    ...eventResourceEndpoints(key),
    STATBOTICS_ENDPOINTS.matches({ event: key }, 1000, 0),
  ];
  const resources = endpoints.map((endpoint) => resource(
    endpoint,
    endpoint === eventEndpoint ? event : endpoint.endsWith("/oprs") ? {} : [],
    acquiredAt,
  ));
  const bundle = {
    version: 1, bootstrap_id: "event-bootstrap-1", kind: "event",
    key, year: 2027, acquired_at: acquiredAt, resources,
  };
  const runtime = new EventRuntime({ storage }, {
    TBA_API_KEY: "test", TBA_WEBHOOK_SECRET: "unused", RUNTIME_ADMIN_TOKEN: "admin",
    fetcher: async () => { throw new Error("bootstrap must not refetch providers"); },
  }, key);
  const request = () => new Request("https://event-runtime/bootstrap", {
    method: "POST", headers: adminHeaders("X-FieldView-Event-Key", key),
    body: JSON.stringify(bundle),
  });

  const first = await runtime.fetch(request());
  assert.equal(first.status, 200);
  assert.equal((await first.json()).duplicate, false);
  assert.ok(storage.values.has("event-state:publication"));
  const revision = storage.values.get("snapshot-revision");

  const second = await runtime.fetch(request());
  assert.equal(second.status, 200);
  assert.equal((await second.json()).duplicate, true);
  assert.equal(storage.values.get("snapshot-revision"), revision);
});

test("TeamRuntime accepts and idempotently republishes a year-scoped bootstrap", async () => {
  const key = "frc3461", year = 2027, acquiredAt = Date.now();
  const storage = new MemoryStorage();
  const endpoints = teamResourceEndpoints(key, year).map((item) => item.endpoint);
  const resources = endpoints.map((endpoint, index) => resource(
    endpoint,
    index === 0 ? { key, team_number: 3461, name: "Bootstrap Team" } : index === 4 || index === 6 ? {} : [],
    acquiredAt,
  ));
  const bundle = {
    version: 1, bootstrap_id: "team-bootstrap-1", kind: "team",
    key, year, acquired_at: acquiredAt, resources,
  };
  const runtime = new TeamRuntime({ storage }, {
    TBA_API_KEY: "test", RUNTIME_ADMIN_TOKEN: "admin",
    fetcher: async () => { throw new Error("bootstrap must not refetch providers"); },
  }, key);
  const request = () => new Request("https://team-runtime/bootstrap?year=" + year, {
    method: "POST", headers: adminHeaders("X-FieldView-Team-Key", key),
    body: JSON.stringify(bundle),
  });

  const first = await runtime.fetch(request());
  assert.equal(first.status, 200);
  assert.equal((await first.json()).duplicate, false);
  assert.ok(storage.values.has("team-state:" + year + ":publication"));
  const revision = storage.values.get("snapshot-revision");

  const second = await runtime.fetch(request());
  assert.equal(second.status, 200);
  assert.equal((await second.json()).duplicate, true);
  assert.equal(storage.values.get("snapshot-revision"), revision);
});
