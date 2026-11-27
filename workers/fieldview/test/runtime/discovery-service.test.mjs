import assert from "node:assert/strict";
import test from "node:test";
import { DiscoveryService } from "../../src/runtime/discovery-service.ts";
import { createDiscoveryServiceClient } from "../../src/jobs/discovery-client.ts";

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

test("DiscoveryServiceClient reads and writes typed D1 JSON records", async () => {
  const state = createState();
  const store = createDiscoveryServiceClient({ DISCOVERY_STORAGE: state.storage });
  await store.put("discovery/events/2026.json", JSON.stringify({ year: 2026 }));
  assert.deepEqual(await store.get("discovery/events/2026.json"), { year: 2026 });
});

test("DiscoveryServiceClient returns null for missing records and rejects invalid JSON", async () => {
  const state = createState();
  const store = createDiscoveryServiceClient({ DISCOVERY_STORAGE: state.storage });
  assert.equal(await store.get("missing"), null);
  await assert.rejects(() => store.put("x", "not-json"), /JSON/);
  const service = new DiscoveryService(state.storage);
  assert.equal((await service.fetch(new Request("https://store/get?key=missing"))).status, 404,
    "the old generic HTTP key/value endpoint is not part of the service contract");
});

test("DiscoveryServiceClient paginates D1 record keys with an exclusive cursor", async () => {
  const state = createState();
  const store = createDiscoveryServiceClient({ DISCOVERY_STORAGE: state.storage });
  for (const key of ["registry/events/2026.json", "registry/events/2027.json", "registry/teams/2026.json"]) {
    await store.put(key, "{}");
  }
  const first = await store.list({ prefix: "registry/events/", limit: 1 });
  assert.deepEqual(first.keys, ["registry/events/2026.json"]);
  assert.equal(first.truncated, true);
  const second = await store.list({ prefix: "registry/events/", limit: 1, cursor: first.cursor });
  assert.deepEqual(second.keys, ["registry/events/2027.json"]);
  assert.equal(second.truncated, false);
});

test("publishing a new team generation removes superseded team pages", async () => {
  const state = createState();
  await state.storage.put("discovery/team-pages/2026/100/0.json", "[]");
  await state.storage.put("discovery/team-pages/2026/200/0.json", "[]");
  await state.storage.put("discovery/teams/2026.json", JSON.stringify({ year: 2026, generation: 100 }));
  const store = new DiscoveryService(state.storage);
  await store.putRecord("discovery/teams/2026.json", JSON.stringify({ year: 2026, generation: 200 }));
  assert.equal(state.values.has("discovery/team-pages/2026/100/0.json"), false);
  assert.equal(state.values.has("discovery/team-pages/2026/200/0.json"), true);
});

test("weekly event candidates are persisted as one canonical projection record", async () => {
  const state = createState();
  const projection = {
    schemaVersion: 1, year: 2026, evaluatedAt: 1795450000000,
    runDate: "2026-11-23", weekStart: "2026-11-23", weekEnd: "2026-11-29",
    checkedAt: 1795450000000, events: [{ key: "2026test" }],
  };
  const store = createDiscoveryServiceClient({ DISCOVERY_STORAGE: state.storage });
  await store.put("projections/events-this-week/current.json", JSON.stringify(projection));
  assert.deepEqual(await store.get("projections/events-this-week/current.json"), projection);
  assert.equal([...state.values.keys()].some((key) => key.includes("projections/events/this-week/")), false);
});

test("DiscoveryService acquires and publishes current-season, team, and event catalogs", async () => {
  const calls = [];
  const state = createState();
  const store = new DiscoveryService(state.storage, {
    TBA_API_KEY: "test-key",
    fetcher: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      calls.push(url.pathname);
      if (url.pathname.endsWith("/status")) return Response.json({ current_season: 2026, max_team_page: 0 });
      if (url.pathname.includes("/teams/2026/")) return Response.json(["frc3461"]);
      if (url.pathname.includes("/events/2026")) {
        return Response.json([{ key: "2026test", start_date: "2026-03-01", end_date: "2026-03-03", timezone: "America/New_York" }], {
          headers: { ETag: '"events-v1"' },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const current = await store.fetch(new Request("https://store/catalog/resolve-current-season", { method: "POST", body: "{}" }));
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json().then(({ year, maxTeamPage }) => ({ year, maxTeamPage })), { year: 2026, maxTeamPage: 0 });

  const teamPage = await store.fetch(new Request("https://store/catalog/discover-team-page", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ year: 2026, generation: 100, page: 0 }),
  }));
  assert.equal(teamPage.status, 200);
  const teams = await teamPage.json();
  assert.deepEqual(teams.teamKeys, ["frc3461"]);

  const teamPublish = await store.fetch(new Request("https://store/catalog/publish-team-directory", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ year: 2026, generation: 100, pageCount: 1, teamKeys: teams.teamKeys }),
  }));
  assert.equal(teamPublish.status, 200);

  const eventDiscovery = await store.fetch(new Request("https://store/catalog/discover-event-directory", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ year: 2026, generation: 200, chunkSize: 25 }),
  }));
  assert.equal(eventDiscovery.status, 200);
  const event = await eventDiscovery.json();
  assert.equal(event.needsChunking, true);

  const prematurePublish = await store.fetch(new Request("https://store/catalog/publish-event-directory", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ year: 2026, generation: 200 }),
  }));
  assert.equal(prematurePublish.status, 409);

  const chunks = await store.fetch(new Request("https://store/catalog/write-event-chunks", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ year: 2026, generation: 200, firstChunk: 0, endChunk: 1, chunkSize: 25 }),
  }));
  assert.equal(chunks.status, 200);

  const published = await store.fetch(new Request("https://store/catalog/publish-event-directory", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ year: 2026, generation: 200 }),
  }));
  assert.equal(published.status, 200);
  assert.deepEqual(JSON.parse(state.values.get("registry/teams/2026.json")), ["frc3461"]);
  const teamManifest = JSON.parse(state.values.get("discovery/teams/2026.json"));
  assert.equal(teamManifest.complete, true);
  assert.equal(teamManifest.expectedPageCount, 1);
  assert.equal(JSON.parse(state.values.get("discovery/events/2026.json")).events[0].key, "2026test");
  assert.ok(calls.some((path) => path.endsWith("/status")));
  assert.ok(calls.some((path) => path.includes("/teams/2026/0/keys")));
  assert.ok(calls.some((path) => path.includes("/events/2026")));
});


test("DiscoveryService accepts page indexes beyond the former hardcoded limit and requests keys only", async () => {
  let requestedPath = "";
  const state = createState();
  const store = new DiscoveryService(state.storage, {
    TBA_API_KEY: "test-key",
    fetcher: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requestedPath = new URL(request.url).pathname;
      return Response.json(["frc3461", "frc9999"]);
    },
  });
  const response = await store.fetch(new Request("https://store/catalog/discover-team-page", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ year: 2026, generation: 300, page: 100 }),
  }));
  assert.equal(response.status, 200);
  assert.equal(requestedPath.endsWith("/teams/2026/100/keys"), true);
  assert.deepEqual((await response.json()).teamKeys, ["frc3461", "frc9999"]);
  assert.deepEqual(JSON.parse(state.values.get("discovery/team-pages/2026/300/100.json")),
    ["frc3461", "frc9999"]);
});

test("partial team publication records failures and supports retrying only failed pages", async () => {
  const state = createState();
  await state.storage.put("registry/teams/2026.json", JSON.stringify(["frc100"]));
  await state.storage.put("discovery/teams/2026.json", JSON.stringify({
    year: 2026, generation: 100, pageCount: 1, teamCount: 1, complete: true,
  }));
  const store = new DiscoveryService(state.storage, {
    TBA_API_KEY: "test-key",
    fetcher: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      return Response.json(path.endsWith("/0/keys") ? ["frc3461"] : ["frc3462"]);
    },
  });
  for (const page of [0, 2]) {
    const acquired = await store.fetch(new Request("https://store/catalog/discover-team-page", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year: 2026, generation: 200, page }),
    }));
    assert.equal(acquired.status, 200);
  }
  const publication = await store.fetch(new Request("https://store/catalog/publish-team-directory", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ year: 2026, generation: 200, pageCount: 3,
      teamKeys: ["frc3461", "frc3462"], failedPages: [1], warnings: ["page 1 failed"] }),
  }));
  assert.equal(publication.status, 200);
  const result = await publication.json();
  assert.equal(result.status, "partial");
  assert.deepEqual(result.failedPages, [1]);
  assert.deepEqual(JSON.parse(state.values.get("registry/teams/2026.json")), ["frc100"]);
  const partial = JSON.parse(state.values.get("discovery/partial-teams/2026/200.json"));
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.teamKeys, ["frc3461", "frc3462"]);
  const resume = await store.fetch(new Request("https://store/catalog/resume-partial-team-directory", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ year: 2026, expectedPageCount: 3 }),
  }));
  const resumed = await resume.json();
  assert.equal(resumed.resumable, true);
  assert.equal(resumed.generation, 200);
  assert.deepEqual(resumed.failedPages, [1]);
  assert.deepEqual(resumed.teamKeys, ["frc3461", "frc3462"]);
  assert.deepEqual(resumed.warnings, ["page 1 failed"]);
});

test("DiscoveryService validates catalog requests and fails closed without a TBA key", async () => {
  let called = false;
  const configured = new DiscoveryService(createState().storage, {
    TBA_API_KEY: "test-key",
    fetcher: async () => { called = true; return Response.json([]); },
  });
  const invalidPage = await configured.fetch(new Request("https://store/catalog/discover-team-page", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ year: 2026, generation: 1, page: -1 }),
  }));
  assert.equal(invalidPage.status, 400);
  assert.equal(called, false);

  const unconfigured = new DiscoveryService(createState().storage);
  const unavailable = await unconfigured.fetch(new Request("https://store/catalog/resolve-current-season", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }));
  assert.equal(unavailable.status, 502);
});
