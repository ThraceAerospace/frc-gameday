import assert from "node:assert/strict";
import test from "node:test";
import { TeamRuntime } from "../src/team-runtime.ts";

class MemoryStorage {
  values = new Map(); alarmAt = null;
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async list({ prefix = "" } = {}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix))); }
  async delete(key) { return this.values.delete(key); }
  async setAlarm(value) { this.alarmAt = Number(value); }
  async deleteAlarm() { this.alarmAt = null; }
  async transaction(callback) { return callback(this); }
}
const env = (fetcher) => ({ TBA_API_KEY: "test-key", RUNTIME_ADMIN_TOKEN: "admin", TBA_WEBHOOK_SECRET: "unused", EVENT_RUNTIME: { idFromName: (key) => key, get: () => ({ fetch: async () => new Response() }) }, fetcher });

test("TeamRuntime lazily schedules and composes canonical team resources", async () => {
  const storage = new MemoryStorage(), calls = [], teamKey = "frc3461";
  const runtime = new TeamRuntime({ storage }, env(async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/team/frc3461")) return Response.json({ key: teamKey, team_number: 3461 }, { headers: { ETag: '"team-v1"' } });
    return Response.json([]);
  }), teamKey);
  const first = await runtime.fetch(new Request("https://team/snapshot?year=2026", { headers: { "X-FieldView-Team-Key": teamKey } }));
  assert.equal(first.status, 200); assert.equal(calls.length, 0);
  assert.equal((await first.json()).team_key, teamKey);
  assert.equal([...storage.values.keys()].filter((key) => key.startsWith("task:")).length, 7);
  await runtime.alarm(); assert.equal(calls.length, 7);
  const second = await runtime.fetch(new Request("https://team/snapshot?year=2026", { headers: { "X-FieldView-Team-Key": teamKey } }));
  const snapshot = await second.json();
  assert.equal(snapshot.team.team_number, 3461);
  assert.equal(snapshot.sources.tba_team.status, "available");
  assert.equal(snapshot.sources.tba_team.validator, '"team-v1"');
  assert.equal(snapshot.team.sources.tba_team.status, "available");
  assert.equal("tba_team_media" in snapshot.team.sources, false);
  assert.equal(snapshot.media.length, 0);
});

test("TeamRuntime retains last-good data and marks a failed refresh stale", async () => {
  const storage = new MemoryStorage(); let fail = false;
  const runtime = new TeamRuntime({ storage }, env(async (url) => {
    if (fail) return new Response("offline", { status: 503 });
    if (String(url).endsWith("/team/frc3461")) return Response.json({ key: "frc3461", team_number: 3461 });
    return Response.json([]);
  }), "frc3461");
  const req = (method="GET") => new Request("https://team/"+(method === "POST" ? "refresh?year=2026" : "snapshot?year=2026"), { method, headers: { Authorization: "Bearer admin", "X-FieldView-Team-Key": "frc3461" } });
  await runtime.fetch(req()); await runtime.alarm();
  fail = true;
  const refresh = await runtime.fetch(req("POST"));
  assert.equal(refresh.status, 200);
  assert.equal((await refresh.json()).attempted, true);
  const snapshot = await (await runtime.fetch(new Request("https://team/snapshot?year=2026", { headers: { "X-FieldView-Team-Key": "frc3461" } }))).json();
  assert.equal(snapshot.team.team_number, 3461);
  assert.equal(snapshot.sources.tba_team.status, "stale");
});


test("TeamRuntime admin seed ingests all team resources before responding", async () => {
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
  assert.equal(result.attempted, true);
  assert.equal(result.snapshot.team.team_number, 3461);
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

test("TeamRuntime restores team identity before a reconstructed object's alarm", async () => {
  const storage = new MemoryStorage(), calls = [];
  const fetcher = async (url) => { calls.push(String(url)); return Response.json([]); };
  const first = new TeamRuntime({ storage }, env(fetcher), "frc3461");
  await first.fetch(new Request("https://team/snapshot?year=2026", {
    headers: { "X-FieldView-Team-Key": "frc3461" },
  }));
  const reconstructed = new TeamRuntime({ storage }, env(fetcher));
  await reconstructed.alarm();
  assert.equal(calls.length, 7);
  assert.ok(calls.some((url) => url.includes("frc3461")));
});


test("TeamRuntime converts numeric public team IDs to TBA frc-prefixed keys", async () => {
  const storage = new MemoryStorage(), calls = [];
  const runtime = new TeamRuntime({ storage }, env(async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/team/frc3461")) return Response.json({ key: "frc3461", team_number: 3461 });
    return Response.json([]);
  }), "3461");
  await runtime.fetch(new Request("https://team/snapshot?year=2026", {
    headers: { "X-FieldView-Team-Key": "3461" },
  }));
  await runtime.alarm();
  assert.equal(calls.length, 7);
  assert.ok(calls.some((url) => url.includes("/team/frc3461")));
  const snapshot = await (await runtime.fetch(new Request("https://team/snapshot?year=2026", {
    headers: { "X-FieldView-Team-Key": "3461" },
  }))).json();
  assert.equal(snapshot.team_key, "3461");
  assert.equal(snapshot.team.team_number, 3461);
});

test("TeamRuntime preserves an explicit null team representation", async () => {
  const storage = new MemoryStorage();
  const runtime = new TeamRuntime({ storage }, env(async (url) => {
    if (String(url).endsWith("/team/frc3461")) return Response.json(null, { headers: { ETag: '"team-null"' } });
    return Response.json([]);
  }), "frc3461");
  await runtime.fetch(new Request("https://team/snapshot?year=2026", {
    headers: { "X-FieldView-Team-Key": "frc3461" },
  }));
  await runtime.alarm();
  const snapshot = await (await runtime.fetch(new Request("https://team/snapshot?year=2026", {
    headers: { "X-FieldView-Team-Key": "frc3461" },
  }))).json();
  assert.equal(snapshot.team, null);
  assert.equal(snapshot.sources.tba_team.status, "available");
});


test("TeamRuntime dispatches each team resource through its declared provider", async () => {
  const storage = new MemoryStorage(), calls = [];
  const runtime = new TeamRuntime({ storage }, env(async (url) => {
    calls.push(String(url));
    return Response.json([]);
  }), "2485");
  const headers = { "X-FieldView-Team-Key": "2485", Authorization: "Bearer admin" };
  await runtime.fetch(new Request("https://team/snapshot?year=2026", { headers }));
  await runtime.alarm();

  const state = await runtime.fetch(new Request("https://team/state", { headers }));
  const diagnostics = await state.json();
  const providers = new Map(diagnostics.polling.map((task) => [task.endpoint, task.provider]));
  assert.equal(providers.get("/team/frc2485"), "tba");
  assert.equal(providers.get("/team/frc2485/districts"), "tba");
  assert.equal(providers.get("/team/frc2485/events/2026"), "tba");
  assert.equal(providers.get("/team/frc2485/media/2026"), "tba");
  assert.equal(providers.get("/team_year/2485/2026"), "statbotics");
  assert.equal(providers.get("/team_events?team=2485&year=2026&limit=1000&offset=0"), "statbotics");
  assert.equal(providers.get("/team/2485"), "frc-colors");

  assert.ok(calls.some((url) => url.includes("thebluealliance.com") && url.endsWith("/team/frc2485")));
  assert.ok(calls.some((url) => url.includes("statbotics") && url.includes("/team_year/2485/2026")));
  assert.ok(calls.some((url) => url.includes("frc-colors") && url.endsWith("/team/2485")));
});
