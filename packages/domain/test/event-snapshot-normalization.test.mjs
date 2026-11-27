import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFieldViewEventState } from "../dist/normalization/event-state.js";

const sources = {
  event: { tba_event: { status: "available", retrieved_at: "2026-11-17T12:00:00.000Z" } },
  teams: { tba_teams: { status: "available", retrieved_at: "2026-11-17T12:00:00.000Z" } },
  event_teams: {
    tba_team_event_status: { status: "available", retrieved_at: "2026-11-17T12:00:00.000Z" },
    tba_event_oprs: { status: "available", retrieved_at: "2026-11-17T12:00:00.000Z" },
  },
  matches: {
    tba_match: { status: "available", retrieved_at: "2026-11-17T12:00:00.000Z" },
    tba_event_predictions: { status: "available", retrieved_at: "2026-11-17T12:00:00.000Z" },
  },
  playoff_alliances: {
    tba_playoff_alliances: { status: "available", retrieved_at: "2026-11-17T12:00:00.000Z" },
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

test("EventState survives JSON transport round-trip without losing provenance", () => {
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

test("composes TBA match predictions, team associations, and playoff alliance provenance", () => {
  const teams = [
    { key: "frc1", team_number: 1 },
    { key: "frc2", team_number: 2 },
    { key: "frc3", team_number: 3 },
    { key: "frc4", team_number: 4 },
    { key: "frc5", team_number: 5 },
    { key: "frc6", team_number: 6 },
  ];
  const statuses = Object.fromEntries([
    ["frc1", "Red"], ["frc2", "Red"], ["frc3", "Red"],
    ["frc4", "Blue"], ["frc5", "Blue"], ["frc6", "Blue"],
  ].map(([key, name]) => [key, { alliance: { name } }]));
  const tbaMatch = {
    key: "2026test_sf1m1", event_key: "2026test", comp_level: "sf",
    set_number: 1, match_number: 1,
    alliances: {
      red: { team_keys: ["frc1", "frc2", "frc3"], score: -1 },
      blue: { team_keys: ["frc4", "frc5", "frc6"], score: -1 },
    },
  };
  const prediction = {
    winning_alliance: "red", prob: 0.75,
    red: { score: 100 }, blue: { score: 90 },
  };
  const alliances = [
    { name: "Red", picks: ["frc1", "frc2", "frc3"] },
    { name: "Blue", picks: ["frc4", "frc5", "frc6"] },
  ];
  const snapshot = normalizeFieldViewEventSnapshot({
    event_key: "2026test",
    tba_teams: teams,
    tba_team_statuses: statuses,
    tba_event_oprs: {
      oprs: { frc1: 0 }, dprs: { frc1: 0 }, ccwms: { frc1: 0 },
    },
    tba_matches: [tbaMatch],
    tba_event_predictions: { [tbaMatch.key]: prediction },
    tba_playoff_alliances: alliances,
    sources,
  });

  assert.equal(snapshot.matches.length, 1);
  assert.equal(snapshot.matches[0].key, tbaMatch.key);
  assert.deepEqual(snapshot.matches[0].predictions.tba, prediction);
  assert.equal(snapshot.matches[0].teams.red[0].team_number, 1);
  assert.equal(snapshot.matches[0].teams.red[0].opr, 0);
  assert.equal(snapshot.matches[0].playoff_alliances.red.name, "Red");
  assert.equal(snapshot.matches[0].playoff_alliances.blue.name, "Blue");
  assert.equal(snapshot.playoff_alliances[0].event_key, "2026test");
  assert.equal(snapshot.matches[0].sources.tba_event_predictions.status, "available");
  assert.equal(snapshot.playoff_alliances[0].sources.tba_playoff_alliances.status, "available");
});

test("preserves absent and explicit-null match and playoff resources", () => {
  const absent = normalizeFieldViewEventSnapshot({ event_key: "2026test", sources });
  assert.equal("matches" in absent, false);
  assert.equal("playoff_alliances" in absent, false);

  const explicitNull = normalizeFieldViewEventSnapshot({
    event_key: "2026test", tba_matches: null, tba_playoff_alliances: null, sources,
  });
  assert.equal(explicitNull.matches, null);
  assert.equal(explicitNull.playoff_alliances, null);

  const empty = normalizeFieldViewEventSnapshot({
    event_key: "2026test", tba_matches: [], tba_playoff_alliances: [], sources,
  });
  assert.deepEqual(empty.matches, []);
  assert.deepEqual(empty.playoff_alliances, []);
});


test("preserves event rankings, awards, and advancement points as independent TBA resources", () => {
  const rankings = {
    rankings: [{ team_key: "frc3461", rank: 1, extra_stats: [9.5] }],
    extra_stats_info: [{ name: "Total Ranking Points", precision: 2 }],
    sort_order_info: null,
  };
  const awards = [{
    name: "Quality Award",
    award_type: 1,
    event_key: "2026test",
    recipient_list: [{ team_key: "frc3461", awardee: null }],
    year: 2026,
  }];
  const advancementPoints = {
    points: {
      frc3461: {
        qual_points: 4,
        alliance_points: 8,
        elim_points: 12,
        award_points: 5,
        total: 29,
      },
    },
  };
  const resourceSources = {
    ...sources,
    rankings: { tba_event_rankings: { status: "available", retrieved_at: "2026-11-17T12:00:00.000Z" } },
    awards: { tba_event_awards: { status: "available", retrieved_at: "2026-11-17T12:00:00.000Z" } },
    advancement_points: { tba_event_advancement_points: { status: "available", retrieved_at: "2026-11-17T12:00:00.000Z" } },
  };
  const snapshot = normalizeFieldViewEventSnapshot({
    event_key: "2026test",
    tba_event_rankings: rankings,
    tba_event_awards: awards,
    tba_event_advancement_points: advancementPoints,
    sources: resourceSources,
  });

  assert.deepEqual(snapshot.rankings, rankings);
  assert.deepEqual(snapshot.awards, awards);
  assert.deepEqual(snapshot.advancement_points, advancementPoints);
  assert.deepEqual(snapshot.sources.rankings, resourceSources.rankings);
  assert.deepEqual(snapshot.sources.awards, resourceSources.awards);
  assert.deepEqual(snapshot.sources.advancement_points, resourceSources.advancement_points);

  const received = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(received.rankings, rankings);
  assert.deepEqual(received.awards, awards);
  assert.deepEqual(received.advancement_points, advancementPoints);
});

test("keeps event ranking, award, and advancement resources distinct when absent, null, or empty", () => {
  const absent = normalizeFieldViewEventSnapshot({ event_key: "2026test", sources });
  assert.equal("rankings" in absent, false);
  assert.equal("awards" in absent, false);
  assert.equal("advancement_points" in absent, false);

  const explicitNull = normalizeFieldViewEventSnapshot({
    event_key: "2026test",
    tba_event_rankings: null,
    tba_event_awards: null,
    tba_event_advancement_points: null,
    sources,
  });
  assert.equal(explicitNull.rankings, null);
  assert.equal(explicitNull.awards, null);
  assert.equal(explicitNull.advancement_points, null);

  const empty = normalizeFieldViewEventSnapshot({
    event_key: "2026test",
    tba_event_awards: [],
    sources,
  });
  assert.deepEqual(empty.awards, []);
});

test("rejects matches that belong to another event", () => {
  assert.throws(() => normalizeFieldViewEventSnapshot({
    event_key: "2026test",
    tba_matches: [{
      key: "2026other_qm1", event_key: "2026other", comp_level: "qm",
      alliances: { red: { team_keys: [] }, blue: { team_keys: [] } },
    }],
    sources,
  }), /does not match/);
});


test("event normalization does not materialize TeamEventStates", () => {
  const state = normalizeFieldViewEventSnapshot({
    event_key: "2026test",
    tba_teams: [{ key: "frc1", team_number: 1 }],
    tba_matches: [],
    sources,
  });
  assert.equal(state.teams.length, 1);
  assert.deepEqual(state.matches, []);
  assert.equal("team_states" in state, false);
});
