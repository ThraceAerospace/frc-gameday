import test from "node:test";
import assert from "node:assert/strict";
import { mergeAnalyticsInvalidations, planAnalyticsInvalidation } from "../src/invalidation.ts";

test("source dependencies distinguish match, event, team, playoff, and season scopes", () => {
  assert.deepEqual(planAnalyticsInvalidation("tba-event-alliances", null, 1).scopes, ["playoff-aggregate"]);
  assert.deepEqual(planAnalyticsInvalidation("tba-event-oprs", null, 1).scopes, ["team-aggregate"]);
  assert.deepEqual(planAnalyticsInvalidation("season-cohort", null, 1).scopes, ["team-aggregate", "season-comparison"]);
  assert.deepEqual(planAnalyticsInvalidation("statbotics-event-matches", ["m2", "m1", "m2"], 1).scopes,
    ["match-analysis", "event-aggregate", "team-aggregate"]);
});

test("match keys are deduplicated, sorted, and broaden to full match collection when unknown", () => {
  assert.deepEqual(planAnalyticsInvalidation("tba-event-matches", ["b", "", "a", "b"], 1).match_keys, ["a", "b"]);
  assert.equal(planAnalyticsInvalidation("tba-event-matches", null, 1).match_keys, null);
  const merged = mergeAnalyticsInvalidations(
    planAnalyticsInvalidation("tba-event-matches", ["m2"], 20),
    planAnalyticsInvalidation("statbotics-event-matches", ["m1", "m2"], 30),
  );
  assert.deepEqual(merged.match_keys, ["m1", "m2"]);
  assert.deepEqual(merged.sources, ["statbotics-event-matches", "tba-event-matches"]);
  assert.equal(merged.requested_at, 20);
  assert.equal(merged.full_event_recalculation, true);
});

test("any source without a safe narrow dependency preserves whole-event fallback", () => {
  for (const source of [
    "tba-event", "tba-event-teams", "tba-team-event-statuses", "tba-event-matches",
    "tba-event-alliances", "tba-event-oprs", "tba-event-predictions",
    "statbotics-event-matches", "season-cohort", "manual",
  ]) {
    assert.equal(planAnalyticsInvalidation(source, [], 1).full_event_recalculation, true, source);
  }
});
