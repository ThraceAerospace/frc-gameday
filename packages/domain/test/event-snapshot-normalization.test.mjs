import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFieldViewEventSnapshot } from "../dist/normalization/event-snapshot.js";

const sources = {
  event: { tba_event: { status: "available", retrieved_at: "2026-11-17T12:00:00.000Z" } },
  teams: { tba_teams: { status: "available", retrieved_at: "2026-11-17T12:00:00.000Z" } },
  event_teams: {
    tba_team_event_status: { status: "available", retrieved_at: "2026-11-17T12:00:00.000Z" },
    tba_event_oprs: { status: "available", retrieved_at: "2026-11-17T12:00:00.000Z" },
  },
};

test("composes canonical event, team, and event-team objects from independent TBA resources", () => {
  const tbaEvent = { key: "2026test", name: "Test Event", timezone: "America/New_York" };
  const tbaTeams = [
    { key: "frc3461", team_number: 3461, nickname: "Operation P.E.A.C.C.E." },
    { key: "frc7407", team_number: 7407, nickname: "Team 7407" },
  ];
  const statuses = { frc3461: { alliance: null, next_match_key: null } };
  const oprs = {
    oprs: { frc3461: 0, frc7407: 123.4 },
    dprs: { frc3461: 0, frc7407: 56.7 },
    ccwms: { frc3461: 0, frc7407: 66.7 },
  };
  const snapshot = normalizeFieldViewEventSnapshot({
    event_key: "2026test", tba_event: tbaEvent, tba_teams: tbaTeams,
    tba_team_statuses: statuses, tba_event_oprs: oprs, sources,
  });

  assert.deepEqual(snapshot.event, { ...tbaEvent, sources: sources.event });
  assert.deepEqual(snapshot.teams, tbaTeams.map((team) => ({ ...team, sources: sources.teams })));
  assert.equal(snapshot.event_teams.length, 2);
  assert.deepEqual(snapshot.event_teams[0], {
    event_key: "2026test", team_key: "frc3461", tba_status: statuses.frc3461,
    opr: 0, dpr: 0, ccwm: 0, sources: sources.event_teams,
  });
  assert.equal("tba_status" in snapshot.event_teams[1], false);
  assert.equal(snapshot.event_teams[1].opr, 123.4);
  assert.equal(snapshot.event_teams[0].tba_status.alliance, null);
  assert.deepEqual(tbaEvent, { key: "2026test", name: "Test Event", timezone: "America/New_York" });
});

test("preserves not-acquired resources separately from explicit null and empty resources", () => {
  const missing = normalizeFieldViewEventSnapshot({ event_key: "2026test", sources });
  assert.equal("event" in missing, false);
  assert.equal("teams" in missing, false);
  assert.equal("event_teams" in missing, false);
  assert.deepEqual(missing.sources, sources);

  const explicitNull = normalizeFieldViewEventSnapshot({
    event_key: "2026test", tba_event: null, tba_teams: null, sources,
  });
  assert.equal(explicitNull.event, null);
  assert.equal(explicitNull.teams, null);
  assert.equal(explicitNull.event_teams, null);
  assert.deepEqual(explicitNull.sources, sources);

  const empty = normalizeFieldViewEventSnapshot({
    event_key: "2026test", tba_teams: [], sources,
  });
  assert.deepEqual(empty.teams, []);
  assert.deepEqual(empty.event_teams, []);
});

test("event snapshot survives JSON transport round-trip without losing provenance", () => {
  const snapshot = normalizeFieldViewEventSnapshot({
    event_key: "2026test",
    tba_event: { key: "2026test", timezone: "America/New_York" },
    tba_teams: [{ key: "frc3461", team_number: 3461 }],
    tba_team_statuses: { frc3461: null },
    sources,
  });
  const received = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(received, snapshot);
  assert.equal(received.event_teams[0].tba_status, null);
  assert.equal(received.event.sources.tba_event.status, "available");
  assert.deepEqual(received.sources, sources);
});

test("rejects an event resource that belongs to a different event key", () => {
  assert.throws(() => normalizeFieldViewEventSnapshot({
    event_key: "2026test", tba_event: { key: "2026other" }, sources,
  }), /does not match/);
});
