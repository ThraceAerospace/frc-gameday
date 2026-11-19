import test from "node:test";
import assert from "node:assert/strict";
import { mean, standardDeviation, buildAllianceResults } from "../src/calculations.ts";

test("mean and population standard deviation retain existing calculation behavior", () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(standardDeviation([1, 2, 3, 4]), Math.sqrt(1.25));
  assert.equal(mean([]), null);
  assert.equal(standardDeviation([]), null);
});

test("alliance results retain existing score residual and EPA aggregation behavior", () => {
  const records = [{
    match: {
      key: "2026test_qm1", comp_level: "qm", set_number: 1, match_number: 1,
      winning_alliance: "red",
      alliances: {
        red: { team_keys: ["frc1", "frc2", "frc3"], score: 105 },
        blue: { team_keys: ["frc4", "frc5", "frc6"], score: 90 },
      },
    },
    statbotics: {
      pred: { red_score: 100, blue_score: 95 },
      pre_epas: {
        "1": { epa: 10 }, "2": { epa: 20 }, "3": { epa: 30 },
        "4": { epa: 15 }, "5": { epa: 15 }, "6": { epa: 15 },
      },
    },
    statboticsStatus: "ready",
  }];
  const result = buildAllianceResults(records);
  assert.equal(result[0].residual, 5);
  assert.equal(result[0].preEpaTotal, 60);
  assert.equal(result[1].residual, -5);
  assert.equal(result[1].preEpaTotal, 45);
});
