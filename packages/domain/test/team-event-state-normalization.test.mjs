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
  assert.equal("team" in state, false, "team identity remains owned by TeamRuntime team state");
  assert.equal("event_team" in state, false, "event participation remains owned by EventRuntime");
  assert.equal("matches" in state, false, "canonical matches are not copied into TeamEventState");
  assert.deepEqual(state.event_team_ref, {
    owner: "event-runtime", owner_id: "2026test", record_type: "event-team", record_id: "frc1", revision: null,
  });
  assert.deepEqual(state.match_refs, [{
    owner: "event-runtime", owner_id: "2026test", record_type: "match", record_id: "2026test_qm1", revision: null,
  }]);
  assert.equal(state.analytics, undefined);
});

test("TeamEventState preserves absent, explicit-null, and empty match-reference resources", () => {
  const base = { event_key: "2026test", team_key: "frc1", sources };
  const absent = normalizeFieldViewTeamEventState(base);
  assert.equal("match_refs" in absent, false);
  const explicitNull = normalizeFieldViewTeamEventState({ ...base, matches: null });
  assert.equal(explicitNull.match_refs, null);
  const empty = normalizeFieldViewTeamEventState({ ...base, matches: [] });
  assert.deepEqual(empty.match_refs, []);
});

test("TeamEventState rejects matches in which the team did not appear", () => {
  assert.throws(() => normalizeFieldViewTeamEventState({
    event_key: "2026test",
    team_key: "frc1",
    sources,
    matches: [{ ...match, alliances: { red: { team_keys: ["frc2"], score: 0 }, blue: { team_keys: [], score: 0 } } }],
  }), /did not appear/);
});

test("TeamEventState validates team identity and source revision for foreign references", () => {
  assert.throws(() => normalizeFieldViewTeamEventState({
    event_key: "2026test", team_key: "frc1", sources,
    team: { key: "frc2", team_number: 2 },
  }), /Team identity/);
  assert.throws(() => normalizeFieldViewTeamEventState({
    event_key: "2026test", team_key: "frc1", sources,
    matches: [match], event_source_revision: -1,
  }), /source revision/);
  const state = normalizeFieldViewTeamEventState({
    event_key: "2026test", team_key: "frc1", sources,
    event_team: { event_key: "2026test", team_key: "frc1", sources: {} },
    matches: [match], event_source_revision: 7,
  });
  assert.equal(state.event_team_ref.revision, 7);
  assert.equal(state.match_refs[0].revision, 7);
});
