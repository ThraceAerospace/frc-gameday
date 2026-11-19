import test from "node:test";
import assert from "node:assert/strict";
import { buildMatchFlags } from "../src/match-flags.ts";

test("backend match flags preserve existing event-relative thresholds and winner rules", () => {
  const allianceResults = Array.from({ length: 20 }, (_, index) => ({
    matchKey: index === 19 ? "target" : `qm${index + 1}`,
    matchLabel: `Qual ${index + 1}`,
    compLevel: "qm",
    color: index === 19 ? "red" : "blue",
    teamKeys: ["frc1", "frc2", "frc3"],
    predicted: 100,
    actual: 100 + (index === 19 ? 100 : index),
    residual: index === 19 ? 100 : index,
    preEpaTotal: 100 + index,
    winner: false,
    outcome: "unknown",
  }));
  allianceResults.push({
    matchKey: "target", matchLabel: "Qual 20", compLevel: "qm", color: "blue",
    teamKeys: ["frc4", "frc5", "frc6"], predicted: 100, actual: 100,
    residual: 0, preEpaTotal: 100, winner: true, outcome: "win",
  });
  const data = {
    allianceResults,
    qualificationAnalysis: {
      penalties: {
        sampleSize: 10,
        outlierThreshold: 15,
        flaggedMatches: [{
          matchKey: "target", redFlagged: true, blueFlagged: false,
          redPenaltyPoints: 20, bluePenaltyPoints: 0,
        }],
      },
    },
  };
  const record = {
    match: {
      key: "target", comp_level: "qm", match_number: 20, set_number: 1,
      winning_alliance: "blue",
      alliances: {
        red: { team_keys: ["frc1", "frc2", "frc3"], score: 80 },
        blue: { team_keys: ["frc4", "frc5", "frc6"], score: 90 },
      },
    },
    statbotics: { pred: { red_win_prob: 0.8 } },
    statboticsStatus: "ready",
  };

  const flags = buildMatchFlags(data, record);
  assert.equal(flags.prediction.label, "Strong Red");
  assert.equal(flags.prediction.predicted_winner, "red");
  assert.equal(flags.winner, "blue");
  assert.deepEqual(flags.review_flags, [
    "model-upset", "anomalous-score", "large-residual", "high-penalties", "high-alliance-epa",
  ]);
  assert.deepEqual(flags.alliances.red.map((flag) => flag.type), [
    "predicted-win", "anomalous-score", "high-alliance-epa", "large-score-delta", "high-penalties",
  ]);
  assert.deepEqual(flags.alliances.blue.map((flag) => flag.type), ["predicted-loss"]);
});
