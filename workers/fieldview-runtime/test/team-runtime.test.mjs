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
  assert.equal([...storage.values.keys()].filter((key) => key.startsWith("task:")).length, 4);
  await runtime.alarm(); assert.equal(calls.length, 4);
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
  fail = true; await runtime.fetch(req("POST")); await runtime.alarm();
  const snapshot = await (await runtime.fetch(new Request("https://team/snapshot?year=2026", { headers: { "X-FieldView-Team-Key": "frc3461" } }))).json();
  assert.equal(snapshot.team.team_number, 3461);
  assert.equal(snapshot.sources.tba_team.status, "stale");
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
  assert.equal(calls.length, 4);
  assert.ok(calls.every((url) => url.includes("frc3461")));
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
