import test from "node:test";
import assert from "node:assert/strict";

import { associateMatchPlayoffAlliance, normalizeFieldViewMatch } from "../dist/normalization/match.js";
import { archimedesSf13m1TbaMatch } from "../dist/fixtures/archimedes-sf13m1.js";

const sources = {};
const alliance = (alliance_number, overrides = {}) => ({
  event_key: "2026arc", alliance_number, name: `Alliance ${alliance_number}`,
  picks: ["frc7407", "frc5940", "frc9470"], declines: [],
  status: { playoff_type: 0, level: "sf", record: null, current_level_record: null, status: "playing" },
  sources, ...overrides,
});
const eventTeam = (team_key, alliance_number) => ({
  event_key: "2026arc", team_key,
  tba_status: alliance_number === null ? null : { alliance: { number: alliance_number, pick: 0, name: `Alliance ${alliance_number}` } },
  sources,
});

test("two match teams with the same TBA status alliance number identify the alliance", () => {
  const expected = alliance(1);
  const eventTeams = ["frc7407", "frc5940", "frc9470"].map((key) => eventTeam(key, 1));
  assert.strictEqual(associateMatchPlayoffAlliance(["frc7407", "frc5940", "frc9470"], eventTeams, [expected]), expected);
});

test("TBA status alliance number handles incoming and outgoing backup teams", () => {
  const expected = alliance(4, { picks: ["frc10133", "frc2000", "frc3000"], backup: { in: "frc4000", out: "frc3000" } });
  const eventTeams = ["frc10133", "frc2000", "frc4000", "frc3000"].map((key) => eventTeam(key, 4));
  assert.strictEqual(associateMatchPlayoffAlliance(["frc10133", "frc2000", "frc4000"], eventTeams, [expected]), expected);
  assert.strictEqual(associateMatchPlayoffAlliance(["frc10133", "frc2000", "frc3000"], eventTeams, [expected]), expected);
});

test("one matching status and missing or null status do not create an association", () => {
  const expected = alliance(1);
  assert.equal(associateMatchPlayoffAlliance(["frc7407", "frc5940", "frc9470"], [eventTeam("frc7407", 1), eventTeam("frc5940", null)], [expected]), null);
  assert.equal(associateMatchPlayoffAlliance(["frc7407", "frc5940", "frc9470"], [eventTeam("frc7407", 1)], [expected]), null);
});

test("multiple qualifying alliance numbers and duplicate alliance records remain unresolved", () => {
  const first = alliance(1);
  const second = alliance(2, { picks: ["frc6459", "frc3045", "frc10021"] });
  const eventTeams = [eventTeam("frc7407", 1), eventTeam("frc5940", 1), eventTeam("frc6459", 2), eventTeam("frc3045", 2)];
  assert.equal(associateMatchPlayAlliance(["frc7407", "frc5940", "frc6459", "frc3045"], eventTeams, [first, second]), null);
  assert.equal(associateMatchPlayAlliance(["frc7407", "frc5940", "frc9470"], eventTeams, [first, alliance(1)]), null);
});

test("match normalization preserves unknown, unavailable, and non-playoff states", () => {
  const unknown = normalizeFieldViewMatch({ tba_match: archimedesSf13m1TbaMatch, sources });
  assert.equal("playoff_alliances" in unknown, false);
  const unavailable = normalizeFieldViewMatch({ tba_match: archimedesSf13m1TbaMatch, event_teams: null, tba_playoff_alliances: [], sources });
  assert.deepEqual(unavailable.playoff_alliances, { red: null, blue: null });
  const unresolved = normalizeFieldViewMatch({ tba_match: archimedesSf13m1TbaMatch, event_teams: [], tba_playoff_alliances: [], sources });
  assert.deepEqual(unresolved.playoff_alliances, { red: null, blue: null });
  const qualification = { ...archimedesSf13m1TbaMatch, comp_level: "qm" };
  const knownNonPlayoff = normalizeFieldViewMatch({ tba_match: qualification, sources });
  assert.equal(knownNonPlayoff.playoff_alliances, null);
});

test("match normalization attaches red and blue alliance data from TBA status pointers", () => {
  const red = alliance(1);
  const blue = alliance(2, { picks: ["frc6459", "frc3045", "frc10021"] });
  const eventTeams = [
    eventTeam("frc7407", 1), eventTeam("frc5940", 1), eventTeam("frc9470", 1),
    eventTeam("frc6459", 2), eventTeam("frc3045", 2), eventTeam("frc10021", 2),
  ];
  const match = normalizeFieldViewMatch({ tba_match: archimedesSf13m1TbaMatch, event_teams: eventTeams, tba_playoff_alliances: [red, blue], sources });
  assert.strictEqual(match.playoff_alliances.red, red);
  assert.strictEqual(match.playoff_alliances.blue, blue);
});
