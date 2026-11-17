import test from "node:test";
import assert from "node:assert/strict";

import {
  archimedes2026EventOprs,
  archimedesSf13m1SourceFixture,
  archimedesSf13m1StatboticsMatch,
  archimedesSf13m1TbaMatch,
  archimedesSf13m1TbaPrediction,
  archimedesSf13m1TbaTeams,
} from "../dist/fixtures/archimedes-sf13m1.js";

test("TBA match fixture preserves original match identity, alliances, scores, and timestamps", () => {
  assert.equal(archimedesSf13m1TbaMatch.key, "2026arc_sf13m1");
  assert.equal(archimedesSf13m1TbaMatch.event_key, "2026arc");
  assert.deepEqual(archimedesSf13m1TbaMatch.alliances.red.team_keys, [
    "frc7407", "frc5940", "frc9470",
  ]);
  assert.deepEqual(archimedesSf13m1TbaMatch.alliances.blue.team_keys, [
    "frc6459", "frc3045", "frc10021",
  ]);
  assert.equal(archimedesSf13m1TbaMatch.alliances.red.score, 580);
  assert.equal(archimedesSf13m1TbaMatch.alliances.blue.score, 459);
  assert.equal(archimedesSf13m1TbaMatch.score_breakdown.blue.foulPoints, 15);
  assert.equal(archimedesSf13m1TbaMatch.score_breakdown.red.hubScore.uncounted, 4);
  assert.equal(archimedesSf13m1TbaMatch.score_breakdown.blue.hubScore.uncounted, 0);
  assert.equal(archimedesSf13m1TbaMatch.time, 1777735980);
  assert.equal(archimedesSf13m1TbaMatch.actual_time, 1777737540);
  assert.equal(archimedesSf13m1TbaMatch.predicted_time, 1777737684);
  assert.equal(archimedesSf13m1TbaMatch.post_result_time, 1777737786);
});

test("Statbotics match fixture retains its independent prediction, result, and EPA maps", () => {
  assert.equal(archimedesSf13m1StatboticsMatch.key, "2026arc_sf13m1");
  assert.equal(archimedesSf13m1StatboticsMatch.pred.red_win_prob, 0.7272);
  assert.equal(archimedesSf13m1StatboticsMatch.pred.red_score, 718.04);
  assert.equal(archimedesSf13m1StatboticsMatch.pred.blue_score, 651.78);
  assert.equal(archimedesSf13m1StatboticsMatch.result.red_score, 580);
  assert.equal(archimedesSf13m1StatboticsMatch.result.blue_score, 459);
  assert.equal(archimedesSf13m1StatboticsMatch.pre_epas["9470"].comp_9_epa, 0);
  assert.equal(archimedesSf13m1StatboticsMatch.epas["9470"].epa, 289.77);
  assert.equal(archimedesSf13m1StatboticsMatch.pre_epas["7407"].epa, 184.54);
  assert.equal(archimedesSf13m1StatboticsMatch.epas["7407"].epa, 182.05);
});

test("TBA event prediction remains distinct from Statbotics prediction", () => {
  assert.equal(archimedesSf13m1SourceFixture.tba_event_prediction.match_key, "2026arc_sf13m1");
  assert.equal(archimedesSf13m1TbaPrediction.winning_alliance, "red");
  assert.equal(archimedesSf13m1TbaPrediction.prob, 0.7762948013792765);
  assert.equal(archimedesSf13m1TbaPrediction.red.score, 692.1136984636958);
  assert.equal(archimedesSf13m1TbaPrediction.blue.score, 667.6942819472702);
  assert.notEqual(
    archimedesSf13m1TbaPrediction.red.score,
    archimedesSf13m1StatboticsMatch.pred.red_score,
  );
  assert.notEqual(
    archimedesSf13m1TbaPrediction.prob,
    archimedesSf13m1StatboticsMatch.pred.red_win_prob,
  );
});

test("event OPR/DPR/CCWM values remain sourced from the event resource", () => {
  assert.equal(archimedes2026EventOprs.oprs.frc7407, 203.75681148328277);
  assert.equal(archimedes2026EventOprs.dprs.frc5940, 4.962476468745116);
  assert.equal(archimedes2026EventOprs.ccwms.frc6459, -36.57366296893303);
  assert.equal(archimedesSf13m1SourceFixture.tba_event_oprs, archimedes2026EventOprs);
  assert.equal(archimedesSf13m1SourceFixture.tba_teams, archimedesSf13m1TbaTeams);
});

test("TBA team fixture retains its original key and official numeric team number", () => {
  assert.deepEqual(archimedesSf13m1TbaTeams[0], {
    key: "frc7407",
    team_number: 7407,
  });
  assert.equal(typeof archimedesSf13m1TbaTeams[0].key, "string");
  assert.equal(typeof archimedesSf13m1TbaTeams[0].team_number, "number");
  assert.equal(archimedesSf13m1TbaTeams.length, 6);
});

test("fixture groups five distinct source resources without merging their payloads", () => {
  assert.equal(archimedesSf13m1SourceFixture.tba_match, archimedesSf13m1TbaMatch);
  assert.equal(archimedesSf13m1SourceFixture.statbotics_match, archimedesSf13m1StatboticsMatch);
  assert.equal(
    archimedesSf13m1SourceFixture.tba_event_prediction.prediction,
    archimedesSf13m1TbaPrediction,
  );
  assert.equal(archimedesSf13m1SourceFixture.tba_event_oprs, archimedes2026EventOprs);
  assert.notEqual(archimedesSf13m1SourceFixture.tba_match, archimedesSf13m1SourceFixture.statbotics_match);
});
