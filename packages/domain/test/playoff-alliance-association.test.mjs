import test from "node:test";
import assert from "node:assert/strict";

import { associateMatchPlayoffAlliance, normalizeFieldViewMatch } from "../dist/normalization/match.js";
import { archimedesSf13m1TbaMatch } from "../dist/fixtures/archimedes-sf13m1.js";

const sources = {};
const alliance = (name, overrides = {}) => ({
  event_key: "2026arc", name,
  picks: ["frc7407", "frc5940", "frc9470"], declines: [],
  status: { playoff_type: 0, level: "sf", record: null, current_level_record: null, status: "playing" },
  sources, ...overrides,
});
const eventTeam = (team_key, name) => ({
  event_key: "2026arc", team_key,
  tba_status: name === null ? null : { alliance: { number: 4, pick: 0, name } },
  sources,
});

test("two match teams with the same explicit TBA alliance name identify the alliance", () => {
  const expected = alliance("Alliance 4");
  const eventTeams = ["frc7407", "frc5940", "frc9470"].map((key) => eventTeam(key, "Alliance 4"));
  assert.strictEqual(associateMatchPlayoffAlliance(["frc7407", "frc5940", "frc9470"], eventTeams, [expected]), expected);
});

test("explicit alliance name handles incoming and outgoing backup teams", () => {
  const expected = alliance("Alliance 4", { picks: ["frc10133", "frc2000", "frc3000"], backup: { in: "frc4000", out: "frc3000" } });
  const eventTeams = ["frc10133", "frc2000", "frc4000", "frc3000"].map((key) => eventTeam(key, "Alliance 4"));
  assert.strictEqual(associateMatchPlayoffAlliance(["frc10133", "frc2000", "frc4000"], eventTeams, [expected]), expected);
  assert.strictEqual(associateMatchPlayoffAlliance(["frc10133", "frc2000", "frc3000"], eventTeams, [expected]), expected);
});

test("null, missing, or mismatched alliance names do not create an association", () => {
  const expected = alliance("Alliance 4");
  assert.equal(associateMatchPlayoffAlliance(["frc7407", "frc5940", "frc9470"], [eventTeam("frc7407", "Alliance 4"), eventTeam("frc5940", null)], [expected]), null);
  assert.equal(associateMatchPlayoffAlliance(["frc7407", "frc5940", "frc9470"], [eventTeam("frc7407", "Alliance 4")], [expected]), null);
  assert.equal(associateMatchPlayoffAlliance(["frc7407", "frc5940", "frc9470"], ["frc7407", "frc5940", "frc9470"].map((key) => eventTeam(key, "Alliance 5")), [expected]), null);
});

test("multiple qualifying names and duplicate elimination-alliance names remain unresolved", () => {
  const first = alliance("Alliance 1");
  const second = alliance("Alliance 2", { picks: ["frc6459", "frc3045", "frc10021"] });
  const eventTeams = [eventTeam("frc7407", "Alliance 1"), eventTeam("frc5940", "Alliance 1"), eventTeam("frc6459", "Alliance 2"), eventTeam("frc3045", "Alliance 2")];
  assert.equal(associateMatchPlayoffAlliance(["frc7407", "frc5940", "frc6459", "frc3045"], eventTeams, [first, second]), null);
  assert.equal(associateMatchPlayoffAlliance(["frc7407", "frc5940", "frc9470"], ["frc7407", "frc5940", "frc9470"].map((key) => eventTeam(key, "Alliance 1")), [first, alliance("Alliance 1")]), null);
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

test("match normalization attaches red and blue alliances through exact TBA names", () => {
  const red = alliance("Alliance 1");
  const blue = alliance("Alliance 2", { picks: ["frc6459", "frc3045", "frc10021"] });
  const eventTeams = [
    eventTeam("frc7407", "Alliance 1"), eventTeam("frc5940", "Alliance 1"), eventTeam("frc9470", "Alliance 1"),
    eventTeam("frc6459", "Alliance 2"), eventTeam("frc3045", "Alliance 2"), eventTeam("frc10021", "Alliance 2"),
  ];
  const match = normalizeFieldViewMatch({ tba_match: archimedesSf13m1TbaMatch, event_teams: eventTeams, tba_playoff_alliances: [red, blue], sources });
  assert.strictEqual(match.playoff_alliances.red, red);
  assert.strictEqual(match.playoff_alliances.blue, blue);
});
