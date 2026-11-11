import assert from "node:assert/strict";
import { test } from "node:test";
import { loadStandaloneTypeScriptModule } from "../helpers/load-standalone-typescript.mjs";

const {
  getLastMatch,
  getMatchesForTeams,
  getNextMatch,
  hasPostedScore,
  isPlayed,
  matchTime,
  sortMatches,
} = await loadStandaloneTypeScriptModule("src/lib/tba/matchUtils.ts");

function makeMatch({
  key,
  actualTime = null,
  predictedTime = null,
  time = null,
  redScore = -1,
  blueScore = -1,
  redTeams = ["frc1"],
  blueTeams = ["frc2"],
}) {
  return {
    key,
    actual_time: actualTime,
    predicted_time: predictedTime,
    time,
    alliances: {
      red: { score: redScore, team_keys: redTeams },
      blue: { score: blueScore, team_keys: blueTeams },
    },
  };
}

test("isPlayed reflects the provider's actual_time field", () => {
  assert.equal(isPlayed(makeMatch({ key: "played", actualTime: 123 })), true);
  assert.equal(isPlayed(makeMatch({ key: "not-played" })), false);
});

test("hasPostedScore requires non-negative scores for both alliances", () => {
  assert.equal(
    hasPostedScore(makeMatch({ key: "complete", redScore: 80, blueScore: 72 })),
    true,
  );
  assert.equal(
    hasPostedScore(makeMatch({ key: "red-only", redScore: 80, blueScore: -1 })),
    false,
  );
  assert.equal(
    hasPostedScore(makeMatch({ key: "missing", redScore: null, blueScore: 0 })),
    false,
  );
});

test("matchTime prefers predicted_time, then time, then Infinity", () => {
  assert.equal(
    matchTime(makeMatch({ key: "predicted", predictedTime: 200, time: 100 })),
    200,
  );
  assert.equal(matchTime(makeMatch({ key: "scheduled", time: 100 })), 100);
  assert.equal(matchTime(makeMatch({ key: "unscheduled" })), Infinity);
});

test("sortMatches sorts chronologically without mutating the provider array", () => {
  const late = makeMatch({ key: "late", predictedTime: 300 });
  const early = makeMatch({ key: "early", predictedTime: 100 });
  const unscheduled = makeMatch({ key: "unscheduled" });
  const source = [late, unscheduled, early];

  const sorted = sortMatches(source);

  assert.deepEqual(sorted.map((match) => match.key), [
    "early",
    "late",
    "unscheduled",
  ]);
  assert.deepEqual(source.map((match) => match.key), [
    "late",
    "unscheduled",
    "early",
  ]);
});

test("getNextMatch returns the first unscored match from an ordered schedule", () => {
  const matches = [
    makeMatch({ key: "completed", redScore: 80, blueScore: 72 }),
    makeMatch({ key: "next", redScore: -1, blueScore: -1 }),
    makeMatch({ key: "later", redScore: -1, blueScore: -1 }),
  ];

  assert.equal(getNextMatch(matches)?.key, "next");
  assert.equal(getNextMatch(matches.slice(0, 1)), null);
});

test("getLastMatch selects the played match with the latest actual_time", () => {
  const matches = [
    makeMatch({ key: "later-scheduled", actualTime: null }),
    makeMatch({ key: "old-result", actualTime: 100 }),
    makeMatch({ key: "latest-result", actualTime: 300 }),
    makeMatch({ key: "middle-result", actualTime: 200 }),
  ];

  assert.equal(getLastMatch(matches)?.key, "latest-result");
  assert.equal(getLastMatch([matches[0]]), null);
});

test("getMatchesForTeams matches either alliance and preserves empty-filter behavior", () => {
  const first = makeMatch({ key: "first", redTeams: ["frc1", "frc2"] });
  const second = makeMatch({ key: "second", blueTeams: ["frc3", "frc4"] });
  const matches = [first, second];

  assert.deepEqual(
    getMatchesForTeams(matches, ["frc4"]).map((match) => match.key),
    ["second"],
  );
  assert.equal(getMatchesForTeams(matches, []), matches);
  assert.deepEqual(getMatchesForTeams(matches, ["frc999"]), []);
});
