import test from "node:test";
import assert from "node:assert/strict";
import { calculateFieldViewEventTeamComparisonAnalytics } from "../src/event-team-comparison-analytics.ts";

function state(teamNumber, change) {
  return {
    team_key: "frc" + teamNumber,
    event_key: "2026unit",
    sources: {},
    analytics: {
      team_key: "frc" + teamNumber,
      event_key: "2026unit",
      metrics: [],
      findings: [],
      season_comparison: {
        prior_event: {
          event_key: "2026prior",
          event_name: "Prior Event",
          short_name: "prior",
          start_date: "2026-02-01",
        },
        prior_epa: 10,
        current_epa: 10 + change,
        current_epa_percentile: null,
        prior_epa_rank: 1,
        prior_epa_comparison_size: 3,
        current_epa_rank: 1,
        current_epa_comparison_size: 3,
        change,
        comparison_rank: 1,
        comparison_size: 3,
        components: { auto: null, teleop: null, endgame: null },
      },
    },
  };
}

test("EventRuntime ranks TeamRuntime comparisons and exposes largest and smallest EPA changes", () => {
  const result = calculateFieldViewEventTeamComparisonAnalytics(
    [state(3461, 5), state(254, -3), state(1678, 5)],
    4,
    [
      { team_key: "frc3461", revision: 4 },
      { team_key: "frc254", revision: 2 },
      { team_key: "frc1678", revision: 8 },
      { team_key: "frc9999", revision: null },
    ],
    [
      { team_key: "frc3461", revision: 2 },
      { team_key: "frc254", revision: 1 },
      { team_key: "frc1678", revision: 5 },
    ],
    1_800_000_000_000,
  );
  assert.equal(result.population.expected_team_count, 4);
  assert.equal(result.population.eligible_team_count, 3);
  assert.equal(result.population.excluded_team_count, 1);
  assert.deepEqual(result.rankings.map((item) => item.team_key), ["frc254", "frc3461", "frc1678"].sort((a, b) => {
    const changes = { frc254: -3, frc3461: 5, frc1678: 5 };
    return changes[b] - changes[a] || Number(a.slice(3)) - Number(b.slice(3));
  }));
  assert.equal(result.rankings.find((item) => item.team_key === "frc3461").rank, 1);
  assert.equal(result.rankings.find((item) => item.team_key === "frc1678").rank, 1);
  assert.equal(result.largest_change.change, 5);
  assert.equal(result.smallest_change.change, -3);
  assert.equal(result.mean_change, 7 / 3);
  assert.equal(result.team_state_revisions.length, 4);
  assert.equal(result.team_event_state_revisions.length, 3);
});
