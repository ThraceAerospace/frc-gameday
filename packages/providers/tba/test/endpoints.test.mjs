import assert from "node:assert/strict";
import test from "node:test";
import { TBA_ENDPOINTS } from "../src/endpoints.ts";

test("builds event resource paths with unchanged TBA resource names", () => {
  assert.equal(TBA_ENDPOINTS.event("2026test"), "/event/2026test");
  assert.equal(TBA_ENDPOINTS.eventTeams("2026test"), "/event/2026test/teams");
  assert.equal(TBA_ENDPOINTS.eventTeamStatuses("2026test"), "/event/2026test/teams/statuses");
  assert.equal(TBA_ENDPOINTS.eventMatches("2026test"), "/event/2026test/matches");
  assert.equal(TBA_ENDPOINTS.eventAlliances("2026test"), "/event/2026test/alliances");
  assert.equal(TBA_ENDPOINTS.eventOPRs("2026test"), "/event/2026test/oprs");
  assert.equal(TBA_ENDPOINTS.eventPredictions("2026test"), "/event/2026test/predictions");
});

test("encodes segments and rejects invalid keys", () => {
  assert.equal(TBA_ENDPOINTS.event("2026/a"), "/event/2026%2Fa");
  assert.throws(() => TBA_ENDPOINTS.event(""), /non-empty/);
  assert.throws(() => TBA_ENDPOINTS.event(" 2026test"), /whitespace/);
});
