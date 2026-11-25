import assert from "node:assert/strict";
import test from "node:test";
import { TeamRuntime, teamResourceEndpoints } from "../../src/runtime/team-runtime.ts";

class MemoryStorage {
  values = new Map(); alarmAt = null;
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async list({ prefix = "" } = {}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix))); }
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
const env = (fetcher) => ({ TBA_API_KEY: "test-key", RUNTIME_ADMIN_TOKEN: "admin", TBA_WEBHOOK_SECRET: "unused", EVENT_RUNTIME: { idFromName: (key) => key, get: () => ({ fetch: async () => new Response() }) }, DISCOVERY_STORE: { idFromName: (key) => key, get: () => ({ fetch: async () => Response.json({ year: 2026, checkedAt: Date.now() }) }) }, fetcher });

async function drainManualQueue(runtime, storage, max = 20) {
  for (let index = 0; index < max; index += 1) {
    const queue = storage.values.get("manual:poll-queue") ?? [];
    if (queue.length === 0) return;
    storage.values.set("manual:poll-queue", queue.map((item) => ({ ...item, dueAt: Date.now() - 1 })));
    await runtime.alarm();
  }
  assert.equal((storage.values.get("manual:poll-queue") ?? []).length, 0, "manual provider queue should drain within the test bound");
}

test("TeamRuntime does not register a Durable Object alarm handler", () => {
  assert.equal(TeamRuntime.prototype.alarm, undefined);
});

test("TeamRuntime does not replace a last-good publication after a failed provider refresh", async () => {
  const storage = new MemoryStorage();
  const teamKey = "frc3461", year = 2026;
  const resources = teamResourceEndpoints(teamKey, year);
  const lastFetchedAt = Date.now() - 60_000;
  const failedState = {
    endpoint: resources[0].endpoint, status: "failed", data: { key: teamKey, team_number: 3461 },
    providerData: { key: teamKey, team_number: 3461 }, etag: '"last-good"',
    lastFetchedAt, expiresAt: Date.now() - 1, revision: 3,
    validatorRevision: 3, lastAttemptAt: Date.now(), lastWebhookAt: null,
    lastError: "provider unavailable",
  };
  storage.values.set("endpoint:" + resources[0].endpoint, failedState);
  const representationSignature = JSON.stringify(resources.map((resource, index) => index === 0
    ? [failedState.revision, failedState.lastFetchedAt, failedState.etag]
    : null));
  const lastGood = { team_key: teamKey, year, team: { team_number: 3461 }, sources: {} };
  const publication = {
    input_signature: "previous-publication-signature",
    representation_signature: representationSignature,
    state: lastGood,
  };
  storage.values.set("team-state:" + year + ":publication", publication);
  const runtime = new TeamRuntime({ storage }, env(async () => {
    throw new Error("snapshot must not retry provider I/O");
  }), teamKey);

  const response = await runtime.snapshot(year);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), lastGood);
  assert.equal(storage.values.get("team-state:" + year + ":publication"), publication,
    "failed revalidation must preserve the exact last-good publication record");
});

test("TeamRuntime hydrates persisted season publications without deleting legacy copies", async () => {
  const storage = new MemoryStorage();
  const state = { team_key: "frc3461", year: 2026, events: [], sources: {} };
  storage.values.set("team-key", "frc3461");
  storage.values.set("team-state:2026:publication", { input_signature: "persisted-signature", state });
  storage.values.set("team-state:2026", state); // legacy duplicate from the pre-normalized writer
  let providerCalls = 0, activationCalls = 0;
  const runtime = new TeamRuntime({
    storage,
    blockConcurrencyWhile: async (callback) => { activationCalls += 1; await callback(); },
  }, env(async () => { providerCalls += 1; return Response.json([]); }));
  const response = await runtime.fetch(new Request("https://team/snapshot?year=2026", {
    headers: { "X-FieldView-Team-Key": "frc3461" },
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).team_key, "frc3461");
  assert.equal(activationCalls, 1);
  assert.equal(providerCalls, 0);
  assert.equal(storage.values.has("team-state:2026"), true,
    "activation leaves legacy duplicates untouched for an explicit migration");
  const diagnostics = await runtime.fetch(new Request("https://team/state", {
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": "frc3461" },
  }));
  const readiness = (await diagnostics.json()).readiness;
  assert.equal(readiness.hydration, "complete");
  assert.equal(readiness.publications.length, 1);
});

test("TeamRuntime public snapshots remain read-only until an explicit refresh publishes state", async () => {
  const storage = new MemoryStorage(), calls = [], teamKey = "frc3461", year = 2026;
  let activeRequests = 0, maxConcurrentRequests = 0;
  const runtime = new TeamRuntime({ storage }, env(async (url) => {
    calls.push(String(url));
    activeRequests += 1;
    maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 1));
    activeRequests -= 1;
    if (String(url).endsWith("/team/frc3461")) return Response.json({ key: teamKey, team_number: 3461 }, { headers: { ETag: '"team-v1"' } });
    return Response.json([]);
  }), teamKey);
  const read = () => runtime.fetch(new Request("https://team/snapshot?year=" + year, {
    headers: { "X-FieldView-Team-Key": teamKey },
  }));
  const first = await read();
  assert.equal(first.status, 204);
  assert.equal(await first.text(), "", "an existing TeamRuntime without TeamState returns no content");
  const eventState = await runtime.fetch(new Request("https://team/event-state?event_key=2026demand&year=" + year, {
    headers: { "X-FieldView-Team-Key": teamKey },
  }));
  assert.equal(eventState.status, 204, "an existing TeamRuntime without TeamEventState returns no content");
  assert.equal(await eventState.text(), "");
  assert.equal(calls.length, 0, "public reads never initiate provider acquisition");
  assert.equal(storage.alarmAt, null, "public reads do not arm background work");
  assert.equal((storage.values.get("manual:poll-queue") ?? []).length, 0);

  const readiness = await runtime.fetch(new Request("https://team/readiness?year=" + year, {
    method: "POST",
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": teamKey, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }));
  assert.equal(readiness.status, 200);
  const result = await readiness.json();
  assert.equal(result.state_valid, false);
  assert.equal(result.refresh_required, true);
  assert.equal(result.refresh_dispatched, false);
  assert.equal(calls.length, 0, "readiness inspects coverage without provider I/O");
  assert.equal((storage.values.get("manual:poll-queue") ?? []).length, 0);

  assert.equal((await read()).status, 204, "an existing TeamRuntime without TeamState returns no content");
  const refresh = await runtime.fetch(new Request("https://team/refresh?year=" + year, {
    method: "POST",
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": teamKey, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }));
  assert.equal(refresh.status, 200);
  assert.equal(calls.length, 7, "the explicit refresh command fetches each required resource inside TeamRuntime");
  assert.equal((storage.values.get("manual:poll-queue") ?? []).length, 0);
  assert.equal(storage.alarmAt, null);
  assert.equal(maxConcurrentRequests, 1, "one TeamRuntime alarm must never run provider requests concurrently");
  const second = await read();
  assert.equal(second.status, 200);
  const snapshot = await second.json();
  assert.equal(snapshot.team.team_number, 3461);
  assert.equal(snapshot.sources.tba_team.status, "available");
  assert.equal(snapshot.sources.tba_team.validator, '"team-v1"');
  assert.equal(snapshot.team.sources.tba_team.status, "available");
  assert.equal("tba_team_media" in snapshot.team.sources, false);
  assert.equal(snapshot.media.length, 0);
});

test("TeamRuntime seed performs its own provider refresh before returning", async () => {
  const storage = new MemoryStorage();
  const calls = [];
  const runtime = new TeamRuntime({ storage }, env(async (url) => {
    calls.push(String(url));
    return Response.json([]);
  }), "frc3461");
  const response = await runtime.fetch(new Request("https://team/seed?year=2026", {
    method: "POST",
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": "frc3461" },
  }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.queued, false);
  assert.equal(result.attempted, true);
  assert.equal(calls.length, 7, "TeamRuntime seed fetches its own provider resources inline");
  assert.equal(storage.alarmAt, null);
  assert.equal((storage.values.get("manual:poll-queue") ?? []).length, 0);
});


test("TeamRuntime retains last-good data and marks a failed refresh stale", async () => {
  const storage = new MemoryStorage(); let fail = false;
  const runtime = new TeamRuntime({ storage }, env(async (url) => {
    if (fail) return new Response("offline", { status: 503 });
    if (String(url).endsWith("/team/frc3461")) return Response.json({ key: "frc3461", team_number: 3461 });
    return Response.json([]);
  }), "frc3461");
  const ingestProfile = () => new Request("https://team/ingest-resource?year=2026", {
    method: "POST",
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": "frc3461", "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: "/team/frc3461" }),
  });
  const firstRefresh = await runtime.fetch(ingestProfile());
  assert.equal(firstRefresh.status, 200);
  fail = true;
  const refresh = await runtime.fetch(ingestProfile());
  assert.equal(refresh.status, 200);
  const snapshotResponse = await runtime.fetch(new Request("https://team/snapshot?year=2026", {
    headers: { "X-FieldView-Team-Key": "frc3461" },
  }));
  assert.equal(snapshotResponse.headers.get("X-FieldView-Publication-Status"), "stale");
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.team.team_number, 3461);
});


test("TeamRuntime admin seed directly refreshes resources sequentially", async () => {
  const storage = new MemoryStorage(), calls = [];
  const runtime = new TeamRuntime({ storage }, env(async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/team/frc3461")) return Response.json({ key: "frc3461", team_number: 3461 });
    return Response.json([]);
  }), "frc3461");
  const response = await runtime.fetch(new Request("https://team/seed?year=2026", {
    method: "POST",
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": "frc3461" },
  }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.queued, false);
  assert.equal(result.attempted, true);
  assert.equal(calls.length, 7, "seed requests fetch providers directly inside the runtime");
  assert.equal((storage.values.get("manual:poll-queue") ?? []).length, 0);
  const snapshot = await runtime.fetch(new Request("https://team/snapshot?year=2026", {
    headers: { "X-FieldView-Team-Key": "frc3461" },
  }));
  assert.equal((await snapshot.json()).team.team_number, 3461);
  assert.equal(calls.length, 7);
  assert.ok(calls.some((url) => url.includes("frc3461")));
  assert.match(calls[0], /\/team\/frc3461\/events\/2026$/);
});

test("TeamRuntime rejects identity mismatch and protects admin state", async () => {
  const runtime = new TeamRuntime({ storage: new MemoryStorage() }, env(async () => new Response()), "frc3461");
  const mismatch = await runtime.fetch(new Request("https://team/snapshot", { headers: { "X-FieldView-Team-Key": "frc254" } }));
  assert.equal(mismatch.status, 400);
  const state = await runtime.fetch(new Request("https://team/state", { headers: { "X-FieldView-Team-Key": "frc3461" } }));
  assert.equal(state.status, 401);
});






test("TeamRuntime dispatches each team resource through its declared provider", async () => {
  const storage = new MemoryStorage(), calls = [];
  const runtime = new TeamRuntime({ storage }, env(async (url) => {
    calls.push(String(url));
    return Response.json([]);
  }), "2485");
  const headers = { "X-FieldView-Team-Key": "2485", Authorization: "Bearer admin" };
  const refresh = await runtime.fetch(new Request("https://team/refresh?year=2026", { method: "POST", headers }));
  assert.equal(refresh.status, 200);
  assert.equal(calls.length, 7, "TBA changes trigger one-shot Statbotics enrichment within the same direct refresh");

  const state = await runtime.fetch(new Request("https://team/state", { headers }));
  const diagnostics = await state.json();
  assert.equal(diagnostics.polling.length, 0, "direct refresh does not create a durable per-runtime polling queue");

  assert.ok(calls.some((url) => url.includes("thebluealliance.com") && url.endsWith("/team/frc2485")));
  assert.ok(calls.some((url) => url.includes("statbotics") && url.includes("/team_year/2485/2026")));
  assert.ok(calls.some((url) => url.includes("frc-colors") && url.endsWith("/team/2485")));
});

test("TeamRuntime records active events for the coordinator without creating polling tasks", async () => {
  const storage = new MemoryStorage();
  const runtime = new TeamRuntime({ storage }, env(async () => Response.json([])), "frc3461");
  const activity = (eventKey, active) => runtime.fetch(new Request("https://team/activity", {
    method: "POST",
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": "frc3461", "Content-Type": "application/json" },
    body: JSON.stringify({ event_key: eventKey, year: 2026, active }),
  }));
  assert.equal((await activity("2026eventa", true)).status, 200);
  assert.equal((await activity("2026eventb", true)).status, 200);
  let state = await runtime.fetch(new Request("https://team/state", {
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": "frc3461" },
  }));
  let snapshot = await state.json();
  assert.deepEqual(snapshot.active_events, ["2026eventa", "2026eventb"]);
  assert.deepEqual(snapshot.polling, []);
  const firstUpdatedAt = storage.values.get("activity:active-events")["2026eventa"].updatedAt;
  await activity("2026eventa", true);
  assert.equal(storage.values.get("activity:active-events")["2026eventa"].updatedAt, firstUpdatedAt,
    "duplicate activation must be idempotent");
  await activity("2026eventa", false);
  state = await runtime.fetch(new Request("https://team/state", {
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": "frc3461" },
  }));
  snapshot = await state.json();
  assert.deepEqual(snapshot.active_events, ["2026eventb"],
    "one event ending must not clear another active event");
  assert.deepEqual(snapshot.polling, []);
  await activity("2026eventb", false);
  state = await runtime.fetch(new Request("https://team/state", {
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": "frc3461" },
  }));
  snapshot = await state.json();
  assert.deepEqual(snapshot.active_events, []);
  assert.deepEqual(snapshot.polling, []);
});



test("TeamRuntime initializes a persisted partial TeamState on its first non-snapshot request", async () => {
  const storage = new MemoryStorage(), teamKey = "frc3461";
  const runtime = new TeamRuntime({ storage }, env(async () => Response.json([])), teamKey);
  const response = await runtime.fetch(new Request("https://team/state?year=2026", {
    headers: {
      Authorization: "Bearer admin",
      "X-FieldView-Team-Key": teamKey,
    },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(storage.values.get("team-state:2026:publication")?.state, {
    team_key: teamKey,
    year: 2026,
    sources: {},
  });
  assert.equal(storage.values.has("team-state:2026"), false, "TeamState is stored only inside its canonical publication");
});


test("TeamRuntime calculates and persists its own TeamEventState", async () => {
  const storage = new MemoryStorage(), teamKey = "frc3461", eventKey = "2026unit";
  const runtime = new TeamRuntime({ storage }, env(async () => Response.json([])), teamKey);
  const eventState = {
    event_key: eventKey,
    event: { key: eventKey, name: "Unit Test", event_code: "unit", start_date: "2026-03-01", playoff_type: 0 },
    teams: [{ key: teamKey, team_number: 3461, nickname: "Test Team" }],
    event_teams: [{ event_key: eventKey, team_key: teamKey, sources: {} }],
    matches: [],
    sources: { teams: {}, event_teams: {}, matches: {} },
  };
  const comparisonInput = {
    state: "complete",
    team_count: 1,
    total_team_event_records: 1,
    processed_team_event_records: 1,
    unavailable_team_event_records: 0,
    discovery_pending_teams: 0,
    updated_at: 1_800_000_000_000,
    team_state_revisions: [{ team_key: teamKey, revision: 0 }],
    records: [{
      team_number: 3461,
      event: { event_key: eventKey, event_name: "Unit Test", short_name: "unit", start_date: "2026-03-01" },
      epa_total: 20,
      epa_unitless: 0.2,
      breakdown: { auto_epa: 5, teleop_epa: 10, endgame_epa: 5 },
      wins: 0, losses: 0, ties: 0, match_count: 0,
      fetched_at: 1_800_000_000_000,
      status: "ready",
    }],
  };
  const response = await runtime.fetch(new Request("https://team-runtime/event-analytics?year=2026", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin",
      "X-FieldView-Team-Key": teamKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contract_version: 1,
      event_key: eventKey,
      event_source_revision: 4,
      event_state: eventState,
      comparison_input: comparisonInput,
    }),
  }));
  assert.equal(response.status, 200);
  const published = await response.json();
  const saved = storage.values.get("team-event-state:" + eventKey);
  assert.deepEqual(published, {
    contract_version: 1,
    event_key: eventKey,
    team_key: teamKey,
    event_source_revision: 4,
    team_source_revision: 0,
    comparison_input_updated_at: comparisonInput.updated_at,
    team_event_revision: 1,
    state: saved,
  }, "the command returns the versioned result envelope and persisted canonical TeamEventState");
  assert.equal(response.headers.get("X-FieldView-Team-Event-Revision"), "1");
  assert.equal(response.headers.get("X-FieldView-Event-Source-Revision"), "4");
  assert.equal(response.headers.get("X-FieldView-Team-Source-Revision"), "0");
  assert.equal(response.headers.get("X-FieldView-Comparison-Input-Updated-At"), String(comparisonInput.updated_at));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(saved.team_key, teamKey);
  assert.equal(saved.event_key, eventKey);
  assert.equal(saved.analytics.team_key, teamKey);
  assert.deepEqual(saved.event_team_ref, {
    owner: "event-runtime", owner_id: eventKey, record_type: "event-team", record_id: teamKey, revision: 4,
  });
  assert.deepEqual(saved.match_refs, []);
  assert.equal("team" in saved, false);
  assert.equal("event_team" in saved, false);
  assert.equal("matches" in saved, false);
  assert.equal(storage.values.get("team-event-revision:" + eventKey), 1);
  const read = await runtime.fetch(new Request("https://team-runtime/event-state?event_key=" + eventKey + "&year=2026", {
    headers: { "X-FieldView-Team-Key": teamKey },
  }));
  assert.equal(read.status, 200);
  assert.equal((await read.json()).analytics.team_key, teamKey);

  await storage.put("snapshot-revision", 1);
  const stale = await runtime.fetch(new Request("https://team-runtime/event-analytics?year=2026", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin",
      "X-FieldView-Team-Key": teamKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_key: eventKey,
      event_source_revision: 4,
      event_state: eventState,
      comparison_input: comparisonInput,
    }),
  }));
  assert.equal(stale.status, 409);
  const unsupported = await runtime.fetch(new Request("https://team-runtime/event-analytics?year=2026", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin",
      "X-FieldView-Team-Key": teamKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contract_version: 2,
      event_key: eventKey,
      event_source_revision: 4,
      event_state: eventState,
      comparison_input: comparisonInput,
    }),
  }));
  assert.equal(unsupported.status, 400);
});


test("TeamRuntime season analytics GET is read-only and explicit refresh publishes the aggregate", async () => {
  const storage = new MemoryStorage(), teamKey = "frc3461", year = new Date().getUTCFullYear();
  storage.values.set("team-key", teamKey);
  storage.values.set("team-state:" + year + ":publication", {
    input_signature: "seeded-team-state",
    state: { team_key: teamKey, year, sources: {} },
  });
  const eventResource = teamResourceEndpoints(teamKey, year).find((resource) =>
    resource.provider === "tba" && resource.endpoint.includes("/events/"));
  assert.ok(eventResource);
  storage.values.set("endpoint:" + eventResource.endpoint, {
    endpoint: eventResource.endpoint,
    status: "available",
    data: [],
    providerData: [],
    etag: null,
    lastFetchedAt: Date.now(),
    expiresAt: null,
    revision: 1,
    validatorRevision: 1,
    lastAttemptAt: Date.now(),
    lastWebhookAt: null,
  });
  let providerCalls = 0;
  const runtime = new TeamRuntime({ storage }, env(async () => {
    providerCalls += 1;
    return Response.json([]);
  }), teamKey);
  const response = await runtime.fetch(new Request("https://team-runtime/season-analytics?year=" + year, {
    headers: { "X-FieldView-Team-Key": teamKey },
  }));
  assert.equal(response.status, 204, "missing season analytics returns no content without implicit work");
  assert.equal(await response.text(), "");
  assert.equal(storage.values.has("team-season-analytics:" + year), false);
  assert.equal(providerCalls, 0, "the analytics GET does not acquire provider data or calculate inline");
  assert.equal(storage.values.has("season-analytics:due:" + year), false);
  assert.equal(storage.alarmAt, null);
  const explicitRefresh = await runtime.fetch(new Request("https://team-runtime/season-analytics/refresh?year=" + year, {
    method: "POST",
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": teamKey },
  }));
  assert.equal(explicitRefresh.status, 200);
  assert.equal(providerCalls, 0, "the analytics command calculates from already-owned canonical inputs");
  const refreshed = await runtime.fetch(new Request("https://team-runtime/season-analytics?year=" + year, {
    headers: { "X-FieldView-Team-Key": teamKey },
  }));
  assert.equal(refreshed.status, 200);
  const result = await refreshed.json();
  assert.equal(result.team, 3461);
  assert.equal(result.year, year);
  assert.equal(result.eventCount, 0);
  assert.equal(storage.values.has("team-season-analytics:" + year), true);
});


test("TeamRuntime readiness inspects freshness without queueing provider work", async () => {
  const storage = new MemoryStorage(), teamKey = "frc3461", year = 2027, now = Date.now();
  storage.values.set("team-key", teamKey);
  storage.values.set("team-state:" + year + ":publication", {
    input_signature: "seeded-team-state",
    state: { team_key: teamKey, year, sources: {} },
  });
  const resources = teamResourceEndpoints(teamKey, year);
  for (const resource of resources) {
    storage.values.set("endpoint:" + resource.endpoint, {
      endpoint: resource.endpoint, status: "available", revision: 1,
      lastFetchedAt: now, expiresAt: now + 60_000,
    });
  }
  const runtime = new TeamRuntime({ storage }, env(async () => {
    throw new Error("readiness must not fetch providers inline");
  }), teamKey);
  const inspect = () => runtime.fetch(new Request("https://team-runtime/readiness?year=" + year, {
    method: "POST",
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": teamKey, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }));

  const fresh = await inspect();
  assert.equal(fresh.status, 200);
  const freshResult = await fresh.json();
  assert.equal(freshResult.state_valid, true);
  assert.equal(freshResult.refresh_required, false);
  assert.equal(freshResult.refresh_dispatched, false);
  assert.deepEqual(freshResult.stale_resources, []);
  assert.equal(storage.values.get("manual:poll-queue")?.length ?? 0, 0);
  assert.equal(storage.alarmAt, null);

  const staleEndpoint = resources[0].endpoint;
  storage.values.get("endpoint:" + staleEndpoint).expiresAt = Date.now() - 1;
  const stale = await inspect();
  assert.equal(stale.status, 200);
  const staleResult = await stale.json();
  assert.equal(staleResult.state_valid, true);
  assert.equal(staleResult.refresh_required, true);
  assert.equal(staleResult.refresh_dispatched, false);
  assert.deepEqual(staleResult.stale_resources, [staleEndpoint]);
  assert.equal(storage.values.get("manual:poll-queue")?.length ?? 0, 0);
  assert.equal(storage.alarmAt, null);
});

test("TeamRuntime readiness inspects only; explicit refresh materializes the requested season", async () => {
  const storage = new MemoryStorage(), teamKey = "frc3461";
  const currentYear = new Date().getUTCFullYear(), historicalYear = currentYear - 1;
  const runtime = new TeamRuntime({ storage }, env(async () => Response.json([])), teamKey);
  const response = await runtime.fetch(new Request("https://team-runtime/snapshot?year=" + historicalYear, {
    headers: { "X-FieldView-Team-Key": teamKey },
  }));
  assert.equal(response.status, 204, "an existing TeamRuntime without historical TeamState returns no content");
  assert.equal(storage.values.has("team-state:" + currentYear + ":publication"), false);
  assert.equal(storage.values.has("team-state:" + historicalYear + ":publication"), false);
  const readiness = await runtime.fetch(new Request("https://team-runtime/readiness?year=" + historicalYear, {
    method: "POST",
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": teamKey, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }));
  assert.equal(readiness.status, 200);
  assert.equal((await readiness.json()).refresh_required, true);
  assert.equal(storage.values.has("team-state:" + currentYear + ":publication"), false);
  assert.equal(storage.values.has("team-state:" + historicalYear + ":publication"), false);

  const historicalRefresh = await runtime.fetch(new Request("https://team-runtime/refresh?year=" + historicalYear, {
    method: "POST", headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": teamKey },
  }));
  assert.equal(historicalRefresh.status, 200);
  assert.equal(storage.values.get("team-state:" + historicalYear + ":publication")?.state?.year, historicalYear);

  const currentRefresh = await runtime.fetch(new Request("https://team-runtime/refresh?year=" + currentYear, {
    method: "POST", headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": teamKey },
  }));
  assert.equal(currentRefresh.status, 200);
  assert.equal(storage.values.get("team-state:" + currentYear + ":publication")?.state?.year, currentYear);
  assert.equal(storage.values.has("team-state:" + currentYear), false);
  assert.equal(storage.values.has("team-state:" + historicalYear), false);
});


test("TeamRuntime refreshes Statbotics team-year and team-event resources after changed TBA team history", async () => {
  const storage = new MemoryStorage(), calls = [], teamKey = "frc3461";
  const runtime = new TeamRuntime({ storage }, env(async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/team/frc3461")) {
      return Response.json({ key: teamKey, team_number: 3461, nickname: "Updated Team" }, { headers: { ETag: '"team-v2"' } });
    }
    if (String(url).endsWith("/team/frc3461/events/2026")) {
      return Response.json([{ key: "2026test" }], { headers: { ETag: '"events-v2"' } });
    }
    return Response.json([]);
  }), teamKey);

  const refresh = await runtime.fetch(new Request("https://team/refresh?year=2026", {
    method: "POST",
    headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": teamKey, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }));
  assert.equal(refresh.status, 200);
  const scheduled = [...storage.values.keys()].filter((key) => key.startsWith("task:"));
  assert.equal(scheduled.some((key) => key.includes("/team_year/")), false);
  assert.equal(scheduled.some((key) => key.includes("/team_events?")), false);
  assert.ok(calls.some((url) => url.includes("/team_year/3461/2026")), "a changed TBA team record triggers Statbotics team-year acquisition");
  assert.ok(calls.some((url) => url.includes("/team_events?team=3461&year=2026")), "a changed TBA event history triggers Statbotics team-event acquisition");
  const polling = [...storage.values.entries()].filter(([key]) => key.startsWith("task:"));
  assert.ok(polling.every(([key]) => !key.includes("/team_year/") && !key.includes("/team_events?")), "Statbotics resources remain event-driven after acquisition");
});





test("TeamRuntime lazily migrates legacy TeamEventState copies to EventRuntime references", async () => {
  const storage = new MemoryStorage(), teamKey = "frc3461", eventKey = "2026legacy";
  const legacyMatch = {
    key: eventKey + "_qm1",
    event_key: eventKey,
    alliances: {
      red: { team_keys: [teamKey, "frc1", "frc2"], score: 0 },
      blue: { team_keys: ["frc3", "frc4", "frc5"], score: 0 },
    },
  };
  storage.values.set("team-event-state:" + eventKey, {
    event_key: eventKey,
    team_key: teamKey,
    sources: { team: {}, event_team: {}, matches: {} },
    team: { key: teamKey, team_number: 3461 },
    event_team: { event_key: eventKey, team_key: teamKey, sources: {} },
    matches: [legacyMatch],
    analytics: { event_key: eventKey, team_key: teamKey, metrics: [], findings: [] },
  });
  storage.values.set("team-event-state:" + eventKey + ":inputs", {
    event_source_revision: 9, team_source_revision: 2, comparison_input_updated_at: 10,
  });
  const runtime = new TeamRuntime({ storage }, env(async () => {
    throw new Error("reading an existing TeamEventState must not fetch providers");
  }), teamKey);
  const response = await runtime.fetch(new Request("https://team-runtime/event-state?event_key=" + eventKey + "&year=2026", {
    headers: { "X-FieldView-Team-Key": teamKey },
  }));
  assert.equal(response.status, 200);
  const migrated = await response.json();
  assert.equal("team" in migrated, false);
  assert.equal("event_team" in migrated, false);
  assert.equal("matches" in migrated, false);
  assert.deepEqual(migrated.event_team_ref, {
    owner: "event-runtime", owner_id: eventKey, record_type: "event-team", record_id: teamKey, revision: 9,
  });
  assert.deepEqual(migrated.match_refs, [{
    owner: "event-runtime", owner_id: eventKey, record_type: "match", record_id: legacyMatch.key, revision: 9,
  }]);
  assert.equal(migrated.analytics.team_key, teamKey);
  assert.equal("matches" in storage.values.get("team-event-state:" + eventKey), true,
    "public reads normalize the legacy copy but never rewrite durable storage");
});

test("TeamRuntime keeps match webhook data foreign to its team event state", async () => {
  const storage = new MemoryStorage();
  const teamKey = "frc3461", eventKey = "2026test", matchKey = "2026test_qm1";
  const currentMatch = {
    key: matchKey,
    event_key: eventKey,
    alliances: { red: { team_keys: [teamKey, "frc1", "frc2"], score: 10 }, blue: { team_keys: ["frc3", "frc4", "frc5"], score: 8 } },
    predictions: { statbotics: { red_win_prob: 0.7 } },
    teams: { red: [{ team_key: teamKey, opr: 12 }], blue: [] },
    analysis: { score: { red: { actual: 10 }, blue: { actual: 8 } } },
    flags: { winner: "red" },
    sources: { tba_match: { status: "available", retrieved_at: "2026-11-21T00:00:00.000Z" } },
  };
  storage.values.set("team-event-state:" + eventKey, {
    event_key: eventKey, team_key: teamKey,
    sources: { team: {}, event_team: {}, matches: {} },
    match_refs: [{ owner: "event-runtime", owner_id: eventKey, record_type: "match", record_id: matchKey, revision: 0 }],
  });
  const notifications = [];
  const runtime = new TeamRuntime({ storage }, {
    ...env(async () => {
      throw new Error("webhook handling must not perform provider fetches");
    }),
    EVENT_RUNTIME: {
      idFromName: (key) => key,
      get: () => ({
        fetch: async (request) => {
          notifications.push(await request.json());
          return Response.json({ accepted: true });
        },
      }),
    },
  }, teamKey);
  const response = await runtime.fetch(new Request("https://team/webhook", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin",
      "X-FieldView-Team-Key": teamKey,
      "X-FieldView-Event-Key": eventKey,
      "X-FieldView-Webhook-Id": "a".repeat(64),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message_type: "match_score",
      message_data: {
        event_key: eventKey,
        match: {
          key: matchKey, event_key: eventKey,
          alliances: { red: { teams: [teamKey, "frc1", "frc2"], score: 22 }, blue: { teams: ["frc3", "frc4", "frc5"], score: 18 } },
        },
      },
    }),
  }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.changed, false);
  assert.equal(result.canonical_owner, "event-runtime");
  assert.deepEqual(storage.values.get("team-event-state:" + eventKey).match_refs, [{
    owner: "event-runtime", owner_id: eventKey, record_type: "match", record_id: matchKey, revision: 0,
  }]);
  assert.equal("matches" in storage.values.get("team-event-state:" + eventKey), false);
  assert.equal(storage.values.get("team-event-revision:" + eventKey), undefined,
    "a match webhook does not mutate a TeamRuntime-owned record when the changed match belongs to EventRuntime");
  assert.deepEqual(notifications, [], "EventRuntime already receives and owns the original match webhook");
  const duplicateResponse = await runtime.fetch(new Request("https://team/webhook", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin",
      "X-FieldView-Team-Key": teamKey,
      "X-FieldView-Event-Key": eventKey,
      "X-FieldView-Webhook-Id": "a".repeat(64),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message_type: "match_score",
      message_data: {
        event_key: eventKey,
        match: {
          key: matchKey, event_key: eventKey,
          alliances: { red: { teams: [teamKey, "frc1", "frc2"], score: 22 }, blue: { teams: ["frc3", "frc4", "frc5"], score: 18 } },
        },
      },
    }),
  }));
  assert.equal(duplicateResponse.status, 200);
  assert.equal((await duplicateResponse.json()).changed, false);
  assert.equal(storage.values.get("team-event-revision:" + eventKey), undefined, "duplicate delivery must not write a team-owned match copy");
  assert.equal(notifications.length, 0, "team runtime does not relay event-owned match changes");
});

test("TeamRuntime does not copy upcoming-match timing into team-owned state", async () => {
  const storage = new MemoryStorage();
  const teamKey = "frc3461", eventKey = "2026test", matchKey = "2026test_qm1";
  const match = {
    key: matchKey, event_key: eventKey, time: 100, predicted_time: null,
    alliances: { red: { team_keys: [teamKey, "frc1", "frc2"] }, blue: { team_keys: ["frc3", "frc4", "frc5"] } },
    predictions: {}, teams: { red: [], blue: [] }, sources: {},
  };
  storage.values.set("team-event-state:" + eventKey, {
    event_key: eventKey, team_key: teamKey, sources: { team: {}, event_team: {}, matches: {} },
    match_refs: [{ owner: "event-runtime", owner_id: eventKey, record_type: "match", record_id: matchKey, revision: 0 }],
  });
  const runtime = new TeamRuntime({ storage }, env(async () => {
    throw new Error("upcoming-match handling must not perform provider fetches");
  }), teamKey);
  const response = await runtime.fetch(new Request("https://team/webhook", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin", "X-FieldView-Team-Key": teamKey,
      "X-FieldView-Event-Key": eventKey, "X-FieldView-Webhook-Id": "b".repeat(64),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message_type: "upcoming_match",
      message_data: { event_key: eventKey, match_key: matchKey, team_keys: [teamKey], scheduled_time: 200, predicted_time: 250 },
    }),
  }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.changed, false);
  assert.equal(result.canonical_owner, "event-runtime");
  assert.deepEqual(storage.values.get("team-event-state:" + eventKey).match_refs, [{
    owner: "event-runtime", owner_id: eventKey, record_type: "match", record_id: matchKey, revision: 0,
  }]);
  assert.equal("matches" in storage.values.get("team-event-state:" + eventKey), false);
  assert.equal(storage.values.get("team-event-revision:" + eventKey), undefined);
});
