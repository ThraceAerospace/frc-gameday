import test from "node:test";
import assert from "node:assert/strict";

import { normalizeFieldViewMatch } from "../dist/normalization/match.js";
import {
  archimedes2026EventOprs,
  archimedesSf13m1SourceFixture,
  archimedesSf13m1StatboticsMatch,
  archimedesSf13m1TbaMatch,
  archimedesSf13m1TbaPrediction,
  archimedesSf13m1TeamAssociations,
} from "../dist/fixtures/archimedes-sf13m1.js";

const sources = {
  tba_match: {
    status: "available",
    retrieved_at: "2026-05-02T00:00:00.000Z",
  },
  statbotics_match: {
    status: "available",
    retrieved_at: "2026-05-02T00:00:00.000Z",
  },
  tba_event_predictions: {
    status: "available",
    retrieved_at: "2026-05-02T00:00:00.000Z",
  },
  tba_event_oprs: {
    status: "available",
    retrieved_at: "2026-05-02T00:00:00.000Z",
  },
};

test("normalization retains the complete TBA match payload unchanged", () => {
  const match = normalizeFieldViewMatch({
    tba_match: archimedesSf13m1TbaMatch,
    sources,
  });

  assert.deepEqual(match.key, archimedesSf13m1TbaMatch.key);
  assert.deepEqual(match.alliances, archimedesSf13m1TbaMatch.alliances);
  assert.deepEqual(match.score_breakdown, archimedesSf13m1TbaMatch.score_breakdown);
  assert.deepEqual(match.videos, archimedesSf13m1TbaMatch.videos);
  assert.deepEqual(match, {
    ...archimedesSf13m1TbaMatch,
    predictions: {},
    teams: { red: [
      { team_key: "frc7407" },
      { team_key: "frc5940" },
      { team_key: "frc9470" },
    ], blue: [
      { team_key: "frc6459" },
      { team_key: "frc3045" },
      { team_key: "frc10021" },
    ] },
    sources,
  });
});

test("normalization associates independent source resources without replacing predictions", () => {
  const match = normalizeFieldViewMatch({
    tba_match: archimedesSf13m1TbaMatch,
    statbotics_match: archimedesSf13m1StatboticsMatch,
    tba_event_prediction: archimedesSf13m1TbaPrediction,
    tba_event_oprs: archimedes2026EventOprs,
    team_associations: archimedesSf13m1TeamAssociations,
    sources,
  });

  assert.strictEqual(match.predictions.tba, archimedesSf13m1TbaPrediction);
  assert.strictEqual(match.predictions.statbotics, archimedesSf13m1StatboticsMatch.pred);
  assert.strictEqual(match.statbotics_result, archimedesSf13m1StatboticsMatch.result);
  assert.strictEqual(match.statbotics_alliances, archimedesSf13m1StatboticsMatch.alliances);
  assert.deepEqual(match.alliances, archimedesSf13m1TbaMatch.alliances);

  assert.deepEqual(match.teams.red.map((team) => team.team_key), [
    "frc7407", "frc5940", "frc9470",
  ]);
  assert.deepEqual(match.teams.red.map((team) => team.statbotics_team_id), [
    7407, 5940, 9470,
  ]);
  assert.equal(typeof match.teams.red[0].statbotics_team_id, "number");
  assert.equal(match.teams.red[0].opr, archimedes2026EventOprs.oprs.frc7407);
  assert.equal(match.teams.red[0].dpr, archimedes2026EventOprs.dprs.frc7407);
  assert.equal(match.teams.red[0].ccwm, archimedes2026EventOprs.ccwms.frc7407);
  assert.strictEqual(match.teams.red[0].pre_epa, archimedesSf13m1StatboticsMatch.pre_epas["7407"]);
  assert.strictEqual(match.teams.red[0].epa, archimedesSf13m1StatboticsMatch.epas["7407"]);
  assert.equal(match.teams.blue[2].team_key, "frc10021");
  assert.equal(match.teams.blue[2].statbotics_team_id, 10021);
  assert.strictEqual(match.sources, sources);
});

test("normalization does not infer Statbotics IDs from TBA team keys", () => {
  const match = normalizeFieldViewMatch({
    tba_match: archimedesSf13m1TbaMatch,
    statbotics_match: archimedesSf13m1StatboticsMatch,
    sources,
  });

  assert.equal(match.teams.red[0].team_key, "frc7407");
  assert.equal("statbotics_team_id" in match.teams.red[0], false);
  assert.equal("pre_epa" in match.teams.red[0], false);
  assert.equal("epa" in match.teams.red[0], false);
});


test("normalized FieldView match survives JSON transport round-trip", () => {
  const match = normalizeFieldViewMatch({
    tba_match: archimedesSf13m1TbaMatch,
    statbotics_match: archimedesSf13m1StatboticsMatch,
    tba_event_prediction: archimedesSf13m1TbaPrediction,
    tba_event_oprs: archimedes2026EventOprs,
    team_associations: archimedesSf13m1TeamAssociations,
    sources,
  });

  const serialized = JSON.stringify(match);
  assert.equal(typeof serialized, "string");
  const received = JSON.parse(serialized);

  assert.deepEqual(received, match);
  assert.deepEqual(received.alliances, archimedesSf13m1TbaMatch.alliances);
  assert.deepEqual(received.predictions.tba, archimedesSf13m1TbaPrediction);
  assert.deepEqual(received.predictions.statbotics, archimedesSf13m1StatboticsMatch.pred);
  assert.equal(received.teams.red[0].statbotics_team_id, 7407);
  assert.equal(received.teams.red[0].opr, archimedes2026EventOprs.oprs.frc7407);
  assert.equal(received.sources.tba_match.status, "available");
});

test("JSON transport preserves explicit null separately from absent properties", () => {
  const value = {
    explicit_null: null,
    absent_by_design: undefined,
    zero: 0,
  };

  const received = JSON.parse(JSON.stringify(value));

  assert.equal("explicit_null" in received, true);
  assert.equal(received.explicit_null, null);
  assert.equal("absent_by_design" in received, false);
  assert.equal(received.zero, 0);
});
