import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFieldViewTeamEventState } from "../dist/normalization/team-event-state.js";

const sources = { team: {}, event_team: {}, matches: {} };
const match = {
  key: "2026test_qm1",
  event_key: "2026test",
  comp_level: "qm",
  alliances: {
    red: { team_keys: ["frc1", "frc2", "frc3"], score: 0 },
    blue: { team_keys: ["frc4", "frc5", "frc6"], score: 0 },
  },
};

test("TeamRuntime-owned TeamEventState normalizes only the requested team's event participation", () => {
  const state = normalizeFieldViewTeamEventState({
    event_key: "2026test",
    team_key: "frc1",
    sources,
    team: { key: "frc1", team_number: 1 },
    event_team: { event_key: "2026test", team_key: "frc1", sources: {} },
    matches: [match],
  });
  assert.equal(state.team_key, "frc1");
  assert.equal(state.event_key, "2026test");
  assert.deepEqual(state.matches, [match]);
  assert.equal(state.analytics, undefined);
});

test("TeamEventState preserves absent, explicit-null, and empty match resources", () => {
  const base = { event_key: "2026test", team_key: "frc1", sources };
  const absent = normalizeFieldViewTeamEventState(base);
  assert.equal("matches" in absent, false);
  const explicitNull = normalizeFieldViewTeamEventState({ ...base, matches: null });
  assert.equal(explicitNull.matches, null);
  const empty = normalizeFieldViewTeamEventState({ ...base, matches: [] });
  assert.deepEqual(empty.matches, []);
});

test("TeamEventState rejects matches in which the team did not appear", () => {
  assert.throws(() => normalizeFieldViewTeamEventState({
    event_key: "2026test",
    team_key: "frc1",
    sources,
    matches: [{ ...match, alliances: { red: { team_keys: ["frc2"], score: 0 }, blue: { team_keys: [], score: 0 } } }],
  }), /did not appear/);
});
