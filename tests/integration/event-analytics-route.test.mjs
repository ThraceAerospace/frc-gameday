import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTypeScriptModuleWithMocks } from "../helpers/load-typescript-with-mocks.mjs";

async function createRouteHarness({ snapshotError = null } = {}) {
  const calls = [];
  const event = {
    key: "2026ctabc",
    start_date: "2026-03-01",
    playoff_type: 0,
    timezone: "America/New_York",
  };
  const snapshot = {
    schemaVersion: 1,
    eventKey: event.key,
    event,
    teams: [{ teamNumber: 3461 }],
    matches: [{ match: { key: "2026ctabc_qm1" }, statbotics: null }],
    allianceResults: [{ matchKey: "2026ctabc_qm1" }],
    rankings: null,
  };
  const cohort = { state: "complete", records: [] };
  const insights = [{ teamNumber: 3461, summary: ["Review baseline"] }];

  const route = await loadTypeScriptModuleWithMocks(
    "src/app/api/insights/event/[event]/route.ts",
    {
      "@/lib/insights/progressive-service": {
        getEventAnalyticsSnapshot: async (eventKey) => {
          calls.push(["getEventAnalyticsSnapshot", eventKey]);
          if (snapshotError) throw snapshotError;
          return structuredClone(snapshot);
        },
        advanceEventAnalytics: async (...args) => { calls.push(["advanceEventAnalytics", ...args]); },
      },
      "@/lib/insights/season-cohort": {
        getSeasonCohortSnapshot: async (...args) => {
          calls.push(["getSeasonCohortSnapshot", ...args]);
          return cohort;
        },
        advanceSeasonCohort: async (...args) => { calls.push(["advanceSeasonCohort", ...args]); },
      },
      "@/lib/insights/calculations": {
        buildSeasonAwareTeamInsights: (...args) => {
          calls.push(["buildSeasonAwareTeamInsights", ...args]);
          return insights;
        },
      },
    },
  );

  return { GET: route.GET, calls, snapshot, cohort, insights };
}

test("EventAnalytics route rejects invalid event keys before acquiring data", async () => {
  const harness = await createRouteHarness();
  const response = await harness.GET(
    new Request("https://fieldview.test/api/insights/event/bad"),
    { params: Promise.resolve({ event: "bad event" }) },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid event key" });
  assert.equal(harness.calls.length, 0);
});

test("EventAnalytics route composes the persisted snapshot with its season cohort", async () => {
  const harness = await createRouteHarness();
  const response = await harness.GET(
    new Request("https://fieldview.test/api/insights/event/2026ctabc?refresh=1"),
    { params: Promise.resolve({ event: "2026ctabc" }) },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.eventKey, "2026ctabc");
  assert.deepEqual(body.seasonCohort, harness.cohort);
  assert.deepEqual(body.teamInsights, harness.insights);

  const eventAdvance = harness.calls.find(([name]) => name === "advanceEventAnalytics");
  const cohortAdvance = harness.calls.find(([name]) => name === "advanceSeasonCohort");
  assert.deepEqual(eventAdvance, ["advanceEventAnalytics", "2026ctabc", true]);
  assert.deepEqual(cohortAdvance, ["advanceSeasonCohort", "2026ctabc", true]);

  const buildCall = harness.calls.find(([name]) => name === "buildSeasonAwareTeamInsights");
  assert.deepEqual(buildCall[1], harness.snapshot.matches);
  assert.deepEqual(buildCall[2], harness.snapshot.allianceResults);
  assert.deepEqual(buildCall[3], harness.snapshot.teams);
  assert.equal(buildCall[4], null);
  assert.equal(buildCall[5], harness.cohort);
});

test("EventAnalytics route maps snapshot acquisition failures to a bounded 502 response", async () => {
  const harness = await createRouteHarness({ snapshotError: new Error("Redis unavailable") });
  const response = await harness.GET(
    new Request("https://fieldview.test/api/insights/event/2026ctabc"),
    { params: Promise.resolve({ event: "2026ctabc" }) },
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Event analytics are temporarily unavailable",
  });
});
