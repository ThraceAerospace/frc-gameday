import test from "node:test";
import assert from "node:assert/strict";
import { buildFieldViewEventTeamSummaries, calculateFieldViewEventTeamComparisonAnalytics } from "../src/event-team-comparison-analytics.ts";

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


test("EventRuntime team summaries reuse TeamRuntime-owned event analytics", () => {
  const eventState = {
    teams: [
      { key: "frc3461", team_number: 3461, nickname: "Team One" },
      { key: "frc254", team_number: 254, name: "Team Two" },
    ],
    event_teams: [
      { team_key: "frc3461", opr: 100, dpr: 40, ccwm: 60 },
      { team_key: "frc254", opr: 90, dpr: 35, ccwm: 55 },
    ],
  };
  const teamStates = [
    {
      event_key: "2026unit", team_key: "frc3461", sources: {},
      analytics: {
        team_key: "frc3461", event_key: "2026unit", metrics: [
          { metric_key: "epa-contribution-percent", status: "available", value: 42, sample_size: 8 },
        ], findings: [],
        performance: {
          rank: 1, wins: 3, losses: 1, ties: 0, matches_seen: 4, completed_matches: 4,
          epa: 120, epa_percentile: 90, auto_epa: 30, teleop_epa: 60, endgame_epa: 30,
          epa_start: 110, epa_end: 120, epa_change: 10,
        },
      },
    },
    {
      event_key: "2026unit", team_key: "frc254", sources: {},
      analytics: {
        team_key: "frc254", event_key: "2026unit", metrics: [
          { metric_key: "epa-contribution-percent", status: "insufficient-data", value: null, sample_size: 0 },
        ], findings: [],
        performance: {
          rank: 2, wins: 2, losses: 2, ties: 0, matches_seen: 4, completed_matches: 4,
          epa: 90, epa_percentile: 50, auto_epa: 20, teleop_epa: 45, endgame_epa: 25,
          epa_start: 85, epa_end: 90, epa_change: 5,
        },
      },
    },
  ];
  const summaries = buildFieldViewEventTeamSummaries(eventState, teamStates);
  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries[0], {
    team_key: "frc3461", team_number: 3461, name: "Team One",
    opr: 100, dpr: 40, ccwm: 60, epa: 120,
    auto_epa: 30, teleop_epa: 60, endgame_epa: 30,
    matches_seen: 4, epa_percentile: 90,
    epa_contribution_percent: 42, epa_contribution_samples: 8,
  });
  assert.equal(summaries[1].epa_contribution_percent, null);
  assert.equal(summaries[1].epa, 90);
});
