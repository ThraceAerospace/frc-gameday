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
  epas = null,
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
      epas,
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

test("team rows combine official OPR metrics with the latest available Statbotics EPA values", () => {
  const first = makeRecord({
    key: "2026ctabc_qm1",
    epas: {
      "1": { epa: 10, auto_epa: 1, teleop_epa: 6, endgame_epa: 3 },
      "2": { epa: 20, auto_epa: 2, teleop_epa: 12, endgame_epa: 6 },
      "3": { epa: 20, auto_epa: 2, teleop_epa: 12, endgame_epa: 6 },
    },
  });
  const second = makeRecord({
    key: "2026ctabc_qm2",
    preEpas: {
      "1": { epa: 30 },
      "2": { epa: 20 },
      "3": { epa: 20 },
      "4": { epa: 5 },
      "5": { epa: 15 },
      "6": { epa: 25 },
    },
  });
  const teams = [
    { key: "frc1", team_number: 1, nickname: "Alpha" },
    { key: "frc2", team_number: 2, name: "Beta" },
    { key: "frc3", team_number: 3 },
    { key: "frc99", team_number: 99, nickname: "" },
  ];

  const rows = buildTeamRows(teams, {
    oprs: { frc1: 42 },
    dprs: { frc1: 18 },
    ccwms: { frc1: 24 },
  }, [first, second]);

  assert.deepEqual(rows.map(({ teamNumber, name, epa, matchesSeen }) => ({
    teamNumber, name, epa, matchesSeen,
  })), [
    { teamNumber: 1, name: "Alpha", epa: 30, matchesSeen: 2 },
    { teamNumber: 2, name: "Beta", epa: 20, matchesSeen: 2 },
    { teamNumber: 3, name: "Team 3", epa: 20, matchesSeen: 2 },
    { teamNumber: 99, name: "Team 99", epa: null, matchesSeen: 0 },
  ]);

  assert.equal(rows[0].opr, 42);
  assert.equal(rows[0].dpr, 18);
  assert.equal(rows[0].ccwm, 24);
  assert.equal(rows[0].autoEpa, null);
  assert.equal(rows[0].teleopEpa, null);
  assert.equal(rows[0].endgameEpa, null);
  assert.equal(rows[0].epaPercentile, 1);
  assert.equal(rows[1].epaPercentile, 0.25);
  assert.equal(rows[2].epaPercentile, 0.25);
  assert.equal(rows[3].epaPercentile, null);
});

test("team EPA contribution percentages use pre-match EPA and average valid alliance samples", () => {
  const first = makeRecord();
  const second = makeRecord({
    key: "2026ctabc_qm2",
    preEpas: {
      "1": { epa: 20 },
      "2": { epa: 20 },
      "3": { epa: 20 },
      "4": { epa: 5 },
      "5": { epa: 15 },
      "6": { epa: 25 },
    },
  });
  const teams = [
    { key: "frc1", team_number: 1 },
    { key: "frc2", team_number: 2 },
    { key: "frc3", team_number: 3 },
  ];

  const rows = buildTeamRows(teams, null, [first, second]);

  assert.equal(rows[0].epaContributionSamples, 2);
  assert.equal(rows[0].epaContributionPercent, (10 / 60 * 100 + 20 / 60 * 100) / 2);
  assert.equal(rows[1].epaContributionPercent, (20 / 60 * 100 + 20 / 60 * 100) / 2);
  assert.equal(rows[2].epaContributionPercent, (30 / 60 * 100 + 20 / 60 * 100) / 2);
});

test("team EPA contribution sampling excludes negative, missing, and zero-total alliance estimates", () => {
  const negative = makeRecord({
    key: "2026ctabc_qm1",
    preEpas: { "1": { epa: -1 }, "2": { epa: 2 }, "3": { epa: 3 } },
  });
  const missing = makeRecord({
    key: "2026ctabc_qm2",
    preEpas: { "1": { epa: 1 }, "2": { epa: 2 } },
  });
  const zero = makeRecord({
    key: "2026ctabc_qm3",
    preEpas: { "1": { epa: 0 }, "2": { epa: 0 }, "3": { epa: 0 } },
  });
  const teams = [
    { key: "frc1", team_number: 1 },
    { key: "frc2", team_number: 2 },
    { key: "frc3", team_number: 3 },
  ];

  const rows = buildTeamRows(teams, null, [negative, missing, zero]);

  for (const row of rows) {
    assert.equal(row.epaContributionSamples, 0);
    assert.equal(row.epaContributionPercent, null);
  }
});
