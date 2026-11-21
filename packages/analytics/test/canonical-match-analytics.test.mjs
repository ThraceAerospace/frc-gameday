import test from "node:test";
import assert from "node:assert/strict";
import { calculateCanonicalMatchAnalytics, calculateCanonicalTeamEventAnalytics } from "../src/canonical-match-analytics.ts";

test("Canonical aggregate calculates event analytics without embedding TeamEventStates", async () => {
  const teams = (start) => Array.from({ length: 3 }, (_, index) => ({
    team_key: `frc${start + index}`,
    team_number: start + index,
    pre_epa: { epa: 10 * (index + 1) },
    epa: { epa: 15 * (index + 1) },
  }));
  const match = {
    key: "2026test_qm1", event_key: "2026test", comp_level: "qm",
    set_number: 1, match_number: 1, winning_alliance: "red",
    alliances: {
      red: { team_keys: ["frc1", "frc2", "frc3"], score: 105 },
      blue: { team_keys: ["frc4", "frc5", "frc6"], score: 90 },
    },
    teams: { red: teams(1), blue: teams(4) },
    predictions: { statbotics: { red_score: 100, blue_score: 95, red_win_prob: 0.7 } },
    sources: { statbotics_match: { status: "available", retrieved_at: "2026-11-18T12:00:00.000Z" } },
  };
  const state = {
    event_key: "2026test",
    event: { key: "2026test", playoff_type: 0, timezone: "America/New_York" },
    teams: Array.from({ length: 6 }, (_, index) => ({
      key: "frc" + (index + 1), team_number: index + 1,
    })),
    matches: [match],
    sources: {},
  };

  const result = await calculateCanonicalMatchAnalytics(state, [{
    input_key: "matches", provider: "tba", resource: "event-matches",
    source_revision: 4, fetched_at: 1_800_000_000_000, record_count: 1,
    included_count: 1, excluded_count: 0, status: "available",
  }]);
  const calculated = result.matches[0];
  assert.equal(calculated.analysis.score.red.actual, 105);
  assert.equal(calculated.analysis.score.red.predicted, 100);
  assert.equal(calculated.analysis.score.red.delta, 5);
  assert.equal(calculated.analysis.alliance_epa.red.pre_match_total, 60);
  assert.equal(calculated.analysis.alliance_epa.red.post_match_total, 90);
  assert.equal(calculated.analysis.alliance_epa.red.pre_match_team_count, 3);
  assert.equal(calculated.analysis.alliance_epa.red.post_match_team_count, 3);
  assert.equal(calculated.flags.prediction.label, "Lean Red");
  assert.equal(calculated.analysis.audit.inputs[0].source_revision, 4);
  assert.equal(calculated.analysis.audit.definition_versions.length, 12);
  assert.equal(calculated.analysis.audit.input_digest.length, 64);
  assert.equal(result.analytics.event_key, "2026test");
  assert.equal(Object.hasOwn(result, "team_states"), false);
  assert.equal(result.analytics.metrics.find((item) => item.metric_key === "mean-score-residual").value, 0);
  assert.equal(result.analytics.alliance_results.length, 2);
  assert.equal(Object.hasOwn(result.analytics, "team_summaries"), false);
  assert.ok(result.analytics.qualification);
  assert.ok(result.analytics.qualification.prediction_calibration);
  assert.ok(result.analytics.qualification.penalties);
  assert.deepEqual(result.analytics.qualification_anomalies, []);
  assert.equal(result.analytics.playoffs.match_count, 0);
  assert.equal(result.analytics.residual_summary.sample_size, 2);
  assert.ok(result.analytics.prediction_summary);
  assert.equal(result.analytics.collection.processed_match_count, 1);
});

test("canonical match analytics preserves absent and explicit-null match resources", async () => {
  const absent = { event_key: "2026test", sources: {} };
  const explicitNull = { event_key: "2026test", matches: null, sources: {} };
  assert.equal(await calculateCanonicalMatchAnalytics(absent), absent);
  assert.equal(await calculateCanonicalMatchAnalytics(explicitNull), explicitNull);
});

test("TeamRuntime calculates its own season comparison from the shared event input", async () => {
  const teams = (start) => Array.from({ length: 3 }, (_, index) => ({
    team_key: `frc${start + index}`,
    team_number: start + index,
    pre_epa: { epa: 10 * (index + 1) },
    epa: { epa: 15 * (index + 1) },
  }));
  const match = {
    key: "2026test_qm1", event_key: "2026test", comp_level: "qm",
    set_number: 1, match_number: 1, winning_alliance: "red",
    alliances: {
      red: { team_keys: ["frc1", "frc2", "frc3"], score: 105 },
      blue: { team_keys: ["frc4", "frc5", "frc6"], score: 90 },
    },
    teams: { red: teams(1), blue: teams(4) },
    predictions: { statbotics: { red_score: 100, blue_score: 95, red_win_prob: 0.7 } },
  };
  const state = {
    event_key: "2026test",
    event: { key: "2026test", name: "Target", event_code: "test", start_date: "2026-03-01", playoff_type: 0, timezone: "America/New_York" },
    teams: Array.from({ length: 6 }, (_, index) => ({ key: "frc" + (index + 1), team_number: index + 1 })),
    matches: [match],
    sources: {},
  };
  const changes = [10, 5, 4, 3, 2, 1];
  const comparisonRecords = Array.from({ length: 6 }, (_, index) => {
    const teamNumber = index + 1;
    const prior = 50 + index * 10;
    const current = prior + changes[index];
    const record = (eventKey, eventName, startDate, epa) => ({
      team_number: teamNumber,
      event: { event_key: eventKey, event_name: eventName, short_name: eventKey.slice(4), start_date: startDate },
      epa_total: epa, epa_unitless: epa / 100,
      breakdown: { auto_epa: 10 + index + (eventKey === "2026test" ? 2 : 0), teleop_epa: 20, endgame_epa: 5 },
      wins: 4, losses: 2, ties: 0, match_count: 6, fetched_at: 1_800_000_000_000, status: "ready",
    });
    return [
      record("2026prior", "Prior", "2026-02-01", prior),
      record("2026test", "Target", "2026-03-01", current),
    ];
  }).flat();
  const comparisonInput = {
    state: "complete", team_count: 6, total_team_event_records: 12,
    processed_team_event_records: 12, unavailable_team_event_records: 0,
    discovery_pending_teams: 0, updated_at: 1_800_000_000_000, records: comparisonRecords,
  };
  const targetTeamState = { event_key: "2026test", team_key: "frc1", sources: {}, matches: [match] };
  const result = await calculateCanonicalTeamEventAnalytics(state, targetTeamState, [], comparisonInput);
  const analytics = result.analytics;
  assert.ok(analytics);
  assert.equal(analytics.season_comparison.change, 10);
  assert.equal(analytics.season_comparison.comparison_rank, 1);
  assert.equal(analytics.season_comparison.comparison_size, 6);
  assert.equal(analytics.season_comparison.prior_event.event_key, "2026prior");
  assert.equal(analytics.season_history.length, 2);
  assert.equal(analytics.audit.definition_versions.length, 5);
});


test("EventRuntime calculates event analytics without calculating team analytics", async () => {
  const match = {
    key: "2026split_qm1", event_key: "2026split", comp_level: "qm",
    set_number: 1, match_number: 1, winning_alliance: "red",
    alliances: {
      red: { team_keys: ["frc1", "frc2", "frc3"], score: 100 },
      blue: { team_keys: ["frc4", "frc5", "frc6"], score: 90 },
    },
    teams: {
      red: Array.from({ length: 3 }, (_, index) => ({ team_key: "frc" + (index + 1), team_number: index + 1, pre_epa: { epa: 10 }, epa: { epa: 12 } })),
      blue: Array.from({ length: 3 }, (_, index) => ({ team_key: "frc" + (index + 4), team_number: index + 4, pre_epa: { epa: 10 }, epa: { epa: 11 } })),
    },
    predictions: { statbotics: { red_score: 95, blue_score: 95, red_win_prob: 0.6 } },
  };
  const state = {
    event_key: "2026split",
    event: { key: "2026split", playoff_type: 0, timezone: "America/New_York" },
    teams: Array.from({ length: 6 }, (_, index) => ({ key: "frc" + (index + 1), team_number: index + 1 })),
    matches: [match],
    sources: {},
  };
  const result = await calculateCanonicalMatchAnalytics(state);
  assert.ok(result.analytics);
  assert.equal(Object.hasOwn(result, "team_states"), false);
  assert.ok(result.matches[0].flags);
});
