import assert from "node:assert/strict";
import test from "node:test";
import { DiscoveryStore } from "../src/discovery-store.ts";

function createState() {
  const values = new Map();
  return {
    values,
    storage: {
      async get(key) { return values.get(key); },
      async put(key, value) { values.set(key, value); },
      async delete(key) { return values.delete(key); },
      async list(options = {}) {
        const keys = [...values.keys()].filter((key) => key.startsWith(options.prefix ?? "") &&
          (!options.startAfter || key > options.startAfter)).sort().slice(0, options.limit ?? 1000);
        return new Map(keys.map((key) => [key, values.get(key)]));
      },
    },
  };
}

test("DiscoveryStore persists records and returns parsed JSON", async () => {
  const store = new DiscoveryStore(createState());
  const put = await store.fetch(new Request("https://store/put", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "discovery/events/2026.json", value: JSON.stringify({ year: 2026 }) }) }));
  assert.equal(put.status, 200);
  const get = await store.fetch(new Request("https://store/get?key=discovery%2Fevents%2F2026.json"));
  assert.deepEqual(await get.json(), { year: 2026 });
});

test("DiscoveryStore returns 404 for missing records and rejects invalid writes", async () => {
  const store = new DiscoveryStore(createState());
  assert.equal((await store.fetch(new Request("https://store/get?key=missing"))).status, 404);
  const response = await store.fetch(new Request("https://store/put", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "x", value: 1 }) }));
  assert.equal(response.status, 400);
});

test("DiscoveryStore paginates prefix listings with an exclusive cursor", async () => {
  const state = createState();
  for (const key of ["registry/events/2026.json", "registry/events/2027.json", "registry/teams/2026.json"]) {
    await state.storage.put("discovery-object:" + key, "{}");
  }
  const store = new DiscoveryStore(state);
  const first = await (await store.fetch(new Request("https://store/list?prefix=registry%2Fevents%2F&limit=1"))).json();
  assert.deepEqual(first.objects, [{ key: "registry/events/2026.json" }]);
  assert.equal(first.truncated, true);
  const second = await (await store.fetch(new Request("https://store/list?prefix=registry%2Fevents%2F&limit=1&cursor=" + encodeURIComponent(first.cursor)))).json();
  assert.deepEqual(second.objects, [{ key: "registry/events/2027.json" }]);
  assert.equal(second.truncated, false);
});

test("publishing a new team generation removes superseded team pages", async () => {
  const state = createState();
  await state.storage.put("discovery-object:discovery/team-pages/2026/100/0.json", "[]");
  await state.storage.put("discovery-object:discovery/team-pages/2026/200/0.json", "[]");
  await state.storage.put("discovery-object:discovery/teams/2026.json", JSON.stringify({ year: 2026, generation: 100 }));
  const store = new DiscoveryStore(state);
  await store.fetch(new Request("https://store/put", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "discovery/teams/2026.json", value: JSON.stringify({ year: 2026, generation: 200 }) }) }));
  assert.equal(state.values.has("discovery-object:discovery/team-pages/2026/100/0.json"), false);
  assert.equal(state.values.has("discovery-object:discovery/team-pages/2026/200/0.json"), true);
});

test("publishing a new weekly projection pointer removes the previous generation", async () => {
  const state = createState();
  await state.storage.put("discovery-object:projections/events/this-week/100/2026.json", "{}");
  await state.storage.put("discovery-object:projections/events/this-week/200/2026.json", "{}");
  await state.storage.put("discovery-object:projections/events/this-week/current.json", JSON.stringify({ runAt: 100 }));
  const store = new DiscoveryStore(state);
  await store.fetch(new Request("https://store/put", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "projections/events/this-week/current.json", value: JSON.stringify({ runAt: 200 }) }) }));
  assert.equal(state.values.has("discovery-object:projections/events/this-week/100/2026.json"), false);
  assert.equal(state.values.has("discovery-object:projections/events/this-week/200/2026.json"), true);
});

test("DiscoveryStore owns TBA status, event-directory, and team-page provider requests", async () => {
  const requests = [];
  const store = new DiscoveryStore(createState(), {
    TBA_API_KEY: "test-key",
    fetcher: async (input, init) => {
      requests.push({ input: String(input), headers: new Headers(init?.headers) });
      return Response.json({ ok: true });
    },
  });

  const status = await store.fetch(new Request("https://store/provider/status"));
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { ok: true });

  const events = await store.fetch(new Request("https://store/provider/events?year=2026", {
    headers: { "If-None-Match": '"events-v1"' },
  }));
  assert.equal(events.status, 200);
  assert.deepEqual(await events.json(), { ok: true });

  const teams = await store.fetch(new Request("https://store/provider/teams?year=2026&page=2"));
  assert.equal(teams.status, 200);
  assert.deepEqual(await teams.json(), { ok: true });
  assert.equal(requests.length, 3);
  assert.equal(requests[1].headers.get("If-None-Match"), '"events-v1"');
});

test("DiscoveryStore rejects invalid provider discovery queries without calling TBA", async () => {
  let called = false;
  const store = new DiscoveryStore(createState(), {
    TBA_API_KEY: "test-key",
    fetcher: async () => { called = true; return Response.json({}); },
  });
  const response = await store.fetch(new Request("https://store/provider/teams?year=2026&page=-1"));
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test("DiscoveryStore provider operations fail closed when no TBA key is configured", async () => {
  const store = new DiscoveryStore(createState());
  const response = await store.fetch(new Request("https://store/provider/status"));
  assert.equal(response.status, 503);
});
