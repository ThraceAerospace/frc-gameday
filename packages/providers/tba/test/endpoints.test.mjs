import assert from "node:assert/strict";
import test from "node:test";
import { TBA_ENDPOINTS } from "../src/endpoints.ts";

test("builds event resource paths with unchanged TBA resource names", () => {
  assert.equal(TBA_ENDPOINTS.events(2026), "/events/2026");
  assert.equal(TBA_ENDPOINTS.teams(2026), "/teams/2026");
  assert.equal(TBA_ENDPOINTS.eventsSimple(2026), "/events/2026/simple");
  assert.equal(TBA_ENDPOINTS.event("2026test"), "/event/2026test");
  assert.equal(TBA_ENDPOINTS.eventSimple("2026test"), "/event/2026test/simple");
  assert.equal(TBA_ENDPOINTS.eventTeams("2026test"), "/event/2026test/teams");
  assert.equal(TBA_ENDPOINTS.eventTeamsSimple("2026test"), "/event/2026test/teams/simple");
  assert.equal(TBA_ENDPOINTS.eventTeamKeys("2026test"), "/event/2026test/teams/keys");
  assert.equal(TBA_ENDPOINTS.eventMatchesSimple("2026test"), "/event/2026test/matches/simple");
  assert.equal(TBA_ENDPOINTS.eventTeamStatuses("2026test"), "/event/2026test/teams/statuses");
  assert.equal(TBA_ENDPOINTS.eventMatches("2026test"), "/event/2026test/matches");
  assert.equal(TBA_ENDPOINTS.eventAlliances("2026test"), "/event/2026test/alliances");
  assert.equal(TBA_ENDPOINTS.eventOPRs("2026test"), "/event/2026test/oprs");
  assert.equal(TBA_ENDPOINTS.eventPredictions("2026test"), "/event/2026test/predictions");
  assert.equal(TBA_ENDPOINTS.eventRankings("2026test"), "/event/2026test/rankings");
  assert.equal(TBA_ENDPOINTS.eventAwards("2026test"), "/event/2026test/awards");
  assert.equal(TBA_ENDPOINTS.eventAdvancementPoints("2026test"), "/event/2026test/advancement_points");
});

test("encodes segments and rejects invalid keys", () => {
  assert.equal(TBA_ENDPOINTS.event("2026/a"), "/event/2026%2Fa");
  assert.equal(TBA_ENDPOINTS.teamEventStatus("frc/3461", "2026test/a"), "/team/frc%2F3461/event/2026test%2Fa/status");
  assert.throws(() => TBA_ENDPOINTS.event(""), /non-empty/);
  assert.throws(() => TBA_ENDPOINTS.event(" 2026test"), /whitespace/);
});
