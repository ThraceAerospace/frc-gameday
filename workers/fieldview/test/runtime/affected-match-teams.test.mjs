import test from "node:test";
import assert from "node:assert/strict";
import { affectedTeamsForChangedMatches } from "../../src/runtime/affected-match-teams.ts";

const match = (key, red, blue, score = 0) => ({
  key, event_key: "2026test", comp_level: "qm", set_number: 1, match_number: 1,
  alliances: {
    red: { team_keys: red, score },
    blue: { team_keys: blue, score: score + 1 },
  },
  winning_alliance: "",
  score_breakdown: null,
});

test("first match acquisition targets every unique participating team", () => {
  assert.deepEqual(
    affectedTeamsForChangedMatches(undefined, [
      match("2026test_qm1", ["frc1", "frc2"], ["frc3", "frc4"]),
      match("2026test_qm2", ["frc2"], ["frc5"]),
    ]),
    ["frc1", "frc2", "frc3", "frc4", "frc5"],
  );
});

test("only teams in changed matches are affected, including replaced alliance members", () => {
  const before = [
    match("2026test_qm1", ["frc1", "frc2"], ["frc3", "frc4"]),
    match("2026test_qm2", ["frc5"], ["frc6"]),
  ];
  const after = [
    match("2026test_qm1", ["frc1", "frc7"], ["frc3", "frc4"], 10),
    before[1],
  ];
  assert.deepEqual(
    affectedTeamsForChangedMatches(before, after),
    ["frc1", "frc2", "frc3", "frc4", "frc7"],
  );
});

test("an unchanged match collection produces no affected teams", () => {
  const matches = [match("2026test_qm1", ["frc1"], ["frc2"], 5)];
  assert.deepEqual(affectedTeamsForChangedMatches(matches, structuredClone(matches)), []);
});

test("an invalid or duplicate match identity fails closed", () => {
  assert.equal(affectedTeamsForChangedMatches([], [{ alliances: {} }]), null);
  const duplicate = match("2026test_qm1", ["frc1"], ["frc2"]);
  assert.equal(affectedTeamsForChangedMatches([duplicate], [duplicate, duplicate]), null);
});

test("invalid team keys are ignored without dropping valid alliance members", () => {
  assert.deepEqual(
    affectedTeamsForChangedMatches(undefined, [
      match("2026test_qm1", ["frc1", "not-a-team"], ["frc2"]),
    ]),
    ["frc1", "frc2"],
  );
});
