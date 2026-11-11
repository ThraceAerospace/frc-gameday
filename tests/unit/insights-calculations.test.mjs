import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTypeScriptModuleWithMocks } from "../helpers/load-typescript-with-mocks.mjs";

const {
  buildAllianceResults,
  buildTeamRows,
  mean,
  standardDeviation,
} = await loadTypeScriptModuleWithMocks(
  "src/lib/insights/calculations.ts",
  {
    "@/lib/tba/formatters": {
      matchShortName: (match) => match.key,
    },
  },
);

function makeRecord({
  key = "2026ctabc_qm1",
  redTeams = ["frc1", "frc2", "frc3"],
  blueTeams = ["frc4", "frc5", "frc6"],
  redScore = 100,
  blueScore = 80,
  winner = "red",
  redPrediction = 90,
  bluePrediction = 85,
  preEpas = {
    "1": { epa: 10 },
    "2": { epa: 20 },
    "3": { epa: 30 },
    "4": { epa: 5 },
    "5": { epa: 15 },
    "6": { epa: 25 },
  },
} = {}) {
  return {
    match: {
      key,
      comp_level: "qm",
      winning_alliance: winner,
      alliances: {
        red: { score: redScore, team_keys: redTeams },
        blue: { score: blueScore, team_keys: blueTeams },
      },
    },
    statbotics: {
      pred: { red_score: redPrediction, blue_score: bluePrediction },
      pre_epas: preEpas,
    },
    statboticsStatus: "ready",
  };
}

test("mean and population standard deviation use the supplied observations", () => {
  assert.equal(mean([2, 4, 6]), 4);
  assert.equal(standardDeviation([2, 4, 6]), Math.sqrt(8 / 3));
  assert.equal(mean([]), null);
  assert.equal(standardDeviation([]), null);
});

test("alliance results preserve the distinction between prediction, actual score, and residual", () => {
  const [red, blue] = buildAllianceResults([makeRecord()]);

  assert.equal(red.color, "red");
  assert.equal(red.predicted, 90);
  assert.equal(red.actual, 100);
  assert.equal(red.residual, 10);
  assert.equal(red.preEpaTotal, 60);
  assert.equal(red.outcome, "win");

  assert.equal(blue.color, "blue");
  assert.equal(blue.predicted, 85);
  assert.equal(blue.actual, 80);
  assert.equal(blue.residual, -5);
  assert.equal(blue.preEpaTotal, 45);
  assert.equal(blue.outcome, "loss");
});

test("unposted actual scores and missing predictions remain null rather than becoming zero", () => {
  const [red] = buildAllianceResults([
    makeRecord({
      redScore: -1,
      redPrediction: null,
    }),
  ]);

  assert.equal(red.actual, null);
  assert.equal(red.predicted, null);
  assert.equal(red.residual, null);
});

test("an alliance EPA total requires exactly three distinct teams with finite EPA values", () => {
  const incomplete = buildAllianceResults([
    makeRecord({ redTeams: ["frc1", "frc2"] }),
  ])[0];
  const duplicate = buildAllianceResults([
    makeRecord({ redTeams: ["frc1", "frc1", "frc2"] }),
  ])[0];
  const missingValue = buildAllianceResults([
    makeRecord({
      redTeams: ["frc1", "frc2", "frc3"],
      preEpas: { "1": { epa: 10 }, "2": { epa: 20 } },
    }),
  ])[0];

  assert.equal(incomplete.preEpaTotal, null);
  assert.equal(duplicate.preEpaTotal, null);
  assert.equal(missingValue.preEpaTotal, null);
});

test("team contribution sampling rejects duplicate alliance team keys", () => {
  const record = makeRecord({ redTeams: ["frc1", "frc1", "frc2"] });
  const teams = [
    { key: "frc1", team_number: 1, nickname: "One" },
    { key: "frc2", team_number: 2, nickname: "Two" },
  ];

  const rows = buildTeamRows(teams, null, [record]);

  assert.equal(rows.find((team) => team.teamNumber === 1).epaContributionSamples, 0);
  assert.equal(rows.find((team) => team.teamNumber === 2).epaContributionSamples, 0);
});
