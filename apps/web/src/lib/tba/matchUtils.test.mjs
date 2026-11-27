import assert from "node:assert/strict";
import test from "node:test";
import { getLastMatch, getNextMatch, sortMatches } from "./matchUtils.ts";

function match(key, comp_level, set_number, match_number, times = {}, scores = [-1, -1]) {
  return {
    key,
    comp_level,
    set_number,
    match_number,
    ...times,
    alliances: {
      red: { score: scores[0], team_keys: [] },
      blue: { score: scores[1], team_keys: [] },
    },
  };
}

test("web match sorting uses TBA BestTime precedence and stable competition ties", () => {
  const input = [
    match("qm2", "qm", 1, 2, { actual_time: 300, predicted_time: 100, time: 50 }),
    match("qm10", "qm", 1, 10, { actual_time: 0, predicted_time: 200, time: 250 }),
    match("qm1", "qm", 1, 1, { actual_time: 0, predicted_time: 200, time: 250 }),
    match("qm3", "qm", 1, 3, { actual_time: 0, predicted_time: 0, time: 0 }),
  ];

  assert.deepEqual(
    sortMatches(input).map((item) => item.key),
    ["qm1", "qm10", "qm2", "qm3"],
  );
  assert.deepEqual(input.map((item) => item.key), ["qm2", "qm10", "qm1", "qm3"]);
});

test("web match sorting orders competition levels when timestamps are absent", () => {
  const input = [
    match("f1", "f", 1, 1),
    match("qm1", "qm", 1, 1),
    match("sf1", "sf", 1, 1),
    match("ef1", "ef", 1, 1),
    match("qf1", "qf", 1, 1),
  ];

  assert.deepEqual(
    sortMatches(input).map((item) => item.key),
    ["qm1", "ef1", "qf1", "sf1", "f1"],
  );
});

test("next and last match selection semantics remain unchanged", () => {
  const first = match("qm1", "qm", 1, 1, { actual_time: 100 }, [10, 8]);
  const second = match("qm2", "qm", 1, 2, { actual_time: 200 }, [-1, -1]);
  const third = match("qm3", "qm", 1, 3, { actual_time: 300 }, [12, 9]);

  assert.equal(getNextMatch([first, second, third])?.key, "qm2");
  assert.equal(getLastMatch([first, second, third])?.key, "qm3");
});
