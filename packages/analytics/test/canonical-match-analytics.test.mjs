import test from "node:test";
import assert from "node:assert/strict";
import { calculateCanonicalMatchAnalytics } from "../src/canonical-match-analytics.ts";

test("EventRuntime canonical enrichment publishes match score and EPA analysis plus flags", () => {
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
    matches: [match],
    sources: {},
    team_states: [{
      event_key: "2026test", team_key: "frc1", sources: {},
      matches: [match],
    }],
  };

  const result = calculateCanonicalMatchAnalytics(state);
  const calculated = result.matches[0];
  assert.equal(calculated.analysis.score.red.actual, 105);
  assert.equal(calculated.analysis.score.red.predicted, 100);
  assert.equal(calculated.analysis.score.red.delta, 5);
  assert.equal(calculated.analysis.alliance_epa.red.pre_match_total, 60);
  assert.equal(calculated.analysis.alliance_epa.red.post_match_total, 90);
  assert.equal(calculated.analysis.alliance_epa.red.pre_match_team_count, 3);
  assert.equal(calculated.analysis.alliance_epa.red.post_match_team_count, 3);
  assert.equal(calculated.flags.prediction.label, "Lean Red");
  assert.equal(result.team_states[0].matches[0], calculated);
});

test("canonical match analytics preserves absent and explicit-null match resources", () => {
  const absent = { event_key: "2026test", sources: {} };
  const explicitNull = { event_key: "2026test", matches: null, sources: {} };
  assert.equal(calculateCanonicalMatchAnalytics(absent), absent);
  assert.equal(calculateCanonicalMatchAnalytics(explicitNull), explicitNull);
});
