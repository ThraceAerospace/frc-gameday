import test from "node:test";
import assert from "node:assert/strict";

import {
  bestMatchTime,
  compareMatches,
  normalizeFieldViewEventState,
  sortMatches,
  sortMatchesByTime,
} from "../dist/index.js";

function match(key, comp_level, set_number, match_number, times = {}) {
  return {
    key,
    event_key: "2022test",
    comp_level,
    set_number,
    match_number,
    alliances: {
      red: { team_keys: [], score: -1, surrogate_team_keys: [], dq_team_keys: [] },
      blue: { team_keys: [], score: -1, surrogate_team_keys: [], dq_team_keys: [] },
    },
    ...times,
  };
}

test("competition ordering follows TBA level, set, and numeric match order", () => {
  const input = [
    match("f1m1", "f", 1, 1),
    match("qm10", "qm", 1, 10),
    match("sf2m1", "sf", 2, 1),
    match("qm2", "qm", 1, 2),
    match("qf1m1", "qf", 1, 1),
    match("ef1m1", "ef", 1, 1),
    match("unknown", "future", 1, 1),
  ];

  assert.deepEqual(
    sortMatches(input).map((item) => item.key),
    ["qm2", "qm10", "ef1m1", "qf1m1", "sf2m1", "f1m1", "unknown"],
  );
});

test("competition sort is stable when TBA considers matches equal", () => {
  const first = match("first", "qm", 1, 2);
  const second = match("second", "qm", 1, 2);
  assert.equal(compareMatches(first, second), 0);
  assert.deepEqual(sortMatches([first, second]).map((item) => item.key), ["first", "second"]);
});

test("BestTime prefers actual, then predicted, then scheduled and ignores zero", () => {
  assert.equal(bestMatchTime(match("actual", "qm", 1, 1, {
    actual_time: 300, predicted_time: 100, time: 50,
  })), 300);
  assert.equal(bestMatchTime(match("predicted", "qm", 1, 2, {
    actual_time: 0, predicted_time: 200, time: 100,
  })), 200);
  assert.equal(bestMatchTime(match("scheduled", "qm", 1, 3, {
    actual_time: 0, predicted_time: 0, time: 400,
  })), 400);
  assert.equal(bestMatchTime(match("unset", "qm", 1, 4, {
    actual_time: 0, predicted_time: 0, time: 0,
  })), undefined);
});

test("chronological sort uses BestTime, keeps equal-time competition order, and puts unknown times last", () => {
  const input = [
    match("qm2", "qm", 1, 2, { time: 200 }),
    match("qm1", "qm", 1, 1, { time: 200 }),
    match("qm3", "qm", 1, 3, { actual_time: 0, predicted_time: 100 }),
    match("qm4", "qm", 1, 4, { actual_time: 0, predicted_time: 0, time: 0 }),
  ];

  assert.deepEqual(
    sortMatchesByTime(input).map((item) => item.key),
    ["qm3", "qm1", "qm2", "qm4"],
  );
});

test("2022 legacy playoff matches follow scheduled physical play order", () => {
  const input = [
    match("qf1m3", "qf", 1, 3, { time: 900 }),
    match("qf2m2", "qf", 2, 2, { time: 800 }),
    match("qf4m1", "qf", 4, 1, { time: 400 }),
    match("qf1m1", "qf", 1, 1, { time: 100 }),
    match("qf3m2", "qf", 3, 2, { time: 700 }),
    match("qf2m1", "qf", 2, 1, { time: 200 }),
    match("qf1m2", "qf", 1, 2, { time: 500 }),
    match("qf3m1", "qf", 3, 1, { time: 300 }),
    match("qf4m2", "qf", 4, 2, { time: 600 }),
  ];

  assert.deepEqual(
    sortMatchesByTime(input).map((item) => item.key),
    ["qf1m1", "qf2m1", "qf3m1", "qf4m1", "qf1m2", "qf4m2", "qf3m2", "qf2m2", "qf1m3"],
  );
});

test("2022 legacy semifinal and final matches follow physical play order", () => {
  const semifinals = [
    match("sf2m2", "sf", 2, 2, { time: 400 }),
    match("sf1m3", "sf", 1, 3, { time: 500 }),
    match("sf2m1", "sf", 2, 1, { time: 200 }),
    match("sf1m1", "sf", 1, 1, { time: 100 }),
    match("sf1m2", "sf", 1, 2, { time: 300 }),
    match("sf2m3", "sf", 2, 3, { time: 600 }),
  ];
  assert.deepEqual(
    sortMatchesByTime(semifinals).map((item) => item.key),
    ["sf1m1", "sf2m1", "sf1m2", "sf2m2", "sf1m3", "sf2m3"],
  );

  const finals = [
    match("f1m3", "f", 1, 3, { time: 300 }),
    match("f1m1", "f", 1, 1, { time: 100 }),
    match("f1m2", "f", 1, 2, { time: 200 }),
  ];
  assert.deepEqual(
    sortMatchesByTime(finals).map((item) => item.key),
    ["f1m1", "f1m2", "f1m3"],
  );
});

test("canonical event snapshot sorts matches instead of preserving TBA array order", () => {
  const inputMatches = [
    match("2022test_f1m1", "f", 1, 1, { time: 900 }),
    match("2022test_qm10", "qm", 1, 10, { time: 300 }),
    match("2022test_qm2", "qm", 1, 2, { time: 100 }),
  ];

  const snapshot = normalizeFieldViewEventState({
    event_key: "2022test",
    tba_matches: inputMatches,
    sources: { event: {}, teams: {}, event_teams: {}, matches: {}, playoff_alliances: {} },
  });

  assert.deepEqual(
    snapshot.matches.map((item) => item.key),
    ["2022test_qm2", "2022test_qm10", "2022test_f1m1"],
  );
  assert.deepEqual(inputMatches.map((item) => item.key), [
    "2022test_f1m1", "2022test_qm10", "2022test_qm2",
  ]);
});
