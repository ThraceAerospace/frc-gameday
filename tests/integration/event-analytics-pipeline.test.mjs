import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTypeScriptModuleWithMocks } from "../helpers/load-typescript-with-mocks.mjs";

class FakeRedis {
  values = new Map();

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async set(key, value) {
    this.values.set(key, value);
    return "OK";
  }

  async del(key) {
    this.values.delete(key);
    return 1;
  }
}

function createEvent(eventKey) {
  return {
    key: eventKey,
    name: "Contract Test Event",
    start_date: "2026-03-01",
    end_date: "2026-03-02",
    timezone: "America/New_York",
    playoff_type: 0,
  };
}

function createMatch(eventKey, number, time) {
  return {
    key: `${eventKey}_qm${number}`,
    comp_level: "qm",
    match_number: number,
    time,
    predicted_time: time,
    actual_time: null,
    winning_alliance: "",
    alliances: {
      red: { score: -1, team_keys: ["frc1", "frc2", "frc3"] },
      blue: { score: -1, team_keys: ["frc4", "frc5", "frc6"] },
    },
  };
}

async function createHarness(eventKey = "2026ctabc") {
  const redis = new FakeRedis();
  const calls = [];
  const event = createEvent(eventKey);
  const teams = [{ key: "frc1", team_number: 1, nickname: "One" }];
  const matches = [
    createMatch(eventKey, 2, 200),
    createMatch(eventKey, 1, 100),
  ];

  const tba = {
    getEvent: async (key) => { calls.push(["getEvent", key]); return event; },
    getTeamsAtEvent: async (key) => { calls.push(["getTeamsAtEvent", key]); return teams; },
    getEventMatches: async (key) => { calls.push(["getEventMatches", key]); return matches; },
    getEventOPRs: async (key) => { calls.push(["getEventOPRs", key]); return null; },
    getEventRankings: async (key) => {
      calls.push(["getEventRankings", key]);
      return null;
    },
    getEventPlayoffAlliances: async (key) => {
      calls.push(["getEventPlayoffAlliances", key]);
      return null;
    },
  };

  const statbotics = {
    getMatches: async () => { throw new Error("snapshot initialization must not fetch Statbotics"); },
  };
  const frcColors = {};
  const calculations = {
    buildAllianceResults: () => [],
    buildTeamRows: () => [],
    buildReviewFindings: () => [],
    buildQualificationAnomalies: () => [],
    buildPlayoffAnalysis: () => ({ matchCount: 0, allianceCount: 0, alliances: [] }),
    buildTeamInsights: () => [],
    buildQualificationAnalysis: () => ({}),
    mean: () => null,
    standardDeviation: () => null,
  };
  const matchUtils = {
    sortMatches: (items) => [...items].sort((a, b) => a.time - b.time),
  };

  const module = await loadTypeScriptModuleWithMocks(
    "src/lib/insights/progressive-service.ts",
    {
      "@/lib/cache/redis": { redis },
      "@/lib/tba/service": { TBA: tba },
      "@/lib/statbotics/service": { Statbotics: statbotics },
      "@/lib/frc-colors/service": { FRCColors: frcColors },
      "@/lib/tba/matchUtils": matchUtils,
      "./calculations": calculations,
    },
  );

  return { ...module, redis, calls, event, teams, matches };
}

test("EventAnalytics snapshot initializes from TBA, persists the job, and emits a versioned FieldView envelope", async () => {
  const eventKey = "2026ctabc";
  const harness = await createHarness(eventKey);

  const snapshot = await harness.getEventAnalyticsSnapshot(eventKey);

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.eventKey, eventKey);
  assert.equal(snapshot.event.key, eventKey);
  assert.equal(snapshot.event.timezone, "America/New_York");
  assert.equal(snapshot.rankings, null);
  assert.deepEqual(snapshot.provenance, {
    event: "tba",
    teams: "tba",
    matches: "tba",
    rankings: "tba",
    oprs: "tba",
    playoffAlliances: "tba",
    statboticsMatches: "statbotics",
    teamColors: "frc-colors",
    derived: "fieldview",
  });
  assert.equal(snapshot.sources.tba.status, "ready");
  assert.equal(snapshot.sources.statbotics.status, "pending");
  assert.equal(snapshot.sources.frcColors.status, "pending");
  assert.equal(snapshot.matchCount, 2);
  assert.equal(snapshot.loadedMatchCount, 0);
  assert.equal(snapshot.collection.state, "queued");

  const persisted = JSON.parse(await harness.redis.get(`insights:progressive:${eventKey}`));
  assert.deepEqual(persisted.matches.map((match) => match.key), [
    "2026ctabc_qm1",
    "2026ctabc_qm2",
  ]);
  assert.deepEqual(persisted.teams, harness.teams);
  assert.deepEqual(persisted.records, {});
  assert.ok(typeof persisted.tbaLoadedAt === "number");

  assert.deepEqual(
    harness.calls.map(([method]) => method).sort(),
    [
      "getEvent",
      "getEventMatches",
      "getEventOPRs",
      "getEventPlayoffAlliances",
      "getEventRankings",
      "getTeamsAtEvent",
    ].sort(),
  );
});

test("EventAnalytics snapshot reads the persisted job without reacquiring provider data", async () => {
  const eventKey = "2026ctxyz";
  const harness = await createHarness(eventKey);
  const persistedJob = {
    event: harness.event,
    teams: harness.teams,
    oprs: null,
    rankings: null,
    playoffAlliances: null,
    matches: [createMatch(eventKey, 1, 100)],
    records: {},
    attempts: {},
    state: "partial",
    updatedAt: Date.now(),
    tbaLoadedAt: Date.now(),
  };
  await harness.redis.set(
    `insights:progressive:${eventKey}`,
    JSON.stringify(persistedJob),
  );

  const snapshot = await harness.getEventAnalyticsSnapshot(eventKey);

  assert.equal(snapshot.eventKey, eventKey);
  assert.equal(snapshot.collection.state, "partial");
  assert.equal(harness.calls.length, 0);
});
