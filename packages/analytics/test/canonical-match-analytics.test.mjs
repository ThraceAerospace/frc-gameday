import test from "node:test";
import assert from "node:assert/strict";
import { calculateCanonicalMatchAnalytics } from "../src/canonical-match-analytics.ts";

test("EventRuntime canonical enrichment publishes match score and EPA analysis plus flags", async () => {
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
    team_states: [{
      event_key: "2026test", team_key: "frc1", sources: {},
      matches: [match],
    }],
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
  assert.equal(calculated.analysis.audit.definition_versions.length, 16);
  assert.equal(calculated.analysis.audit.input_digest.length, 64);
  assert.equal(result.team_states[0].matches[0], calculated);
  assert.equal(result.analytics.event_key, "2026test");
  assert.equal(result.analytics.metrics.find((item) => item.metric_key === "mean-score-residual").value, 0);
  assert.equal(result.team_states[0].analytics.team_key, "frc1");
  assert.equal(result.team_states[0].analytics.metrics.find((item) => item.metric_key === "epa").value, 15);
  assert.ok(result.team_states[0].analytics.metrics.some((item) => item.metric_key === "epa-contribution-percent"));
  assert.equal(result.team_states[0].analytics.audit.calculation_id, calculated.analysis.audit.calculation_id);
  assert.equal(result.analytics.alliance_results.length, 2);
  assert.equal(result.analytics.team_summaries.length, 6);
  assert.ok(result.analytics.qualification);
  assert.ok(result.analytics.qualification.prediction_calibration);
  assert.ok(result.analytics.qualification.penalties);
  assert.deepEqual(result.analytics.qualification_anomalies, []);
  assert.equal(result.analytics.playoffs.match_count, 0);
  assert.equal(result.analytics.residual_summary.sample_size, 2);
  assert.ok(result.analytics.prediction_summary);
  assert.equal(result.analytics.collection.processed_match_count, 1);
  assert.equal(result.team_states[0].analytics.performance.epa, 15);
  assert.ok(Array.isArray(result.team_states[0].analytics.summary));
  assert.ok(Array.isArray(result.team_states[0].analytics.epa_trend));
  assert.ok(result.team_states[0].analytics.peer_performance);
  assert.ok(Array.isArray(result.team_states[0].analytics.review_matches));
});

test("canonical match analytics preserves absent and explicit-null match resources", async () => {
  const absent = { event_key: "2026test", sources: {} };
  const explicitNull = { event_key: "2026test", matches: null, sources: {} };
  assert.equal(await calculateCanonicalMatchAnalytics(absent), absent);
  assert.equal(await calculateCanonicalMatchAnalytics(explicitNull), explicitNull);
});
