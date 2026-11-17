import test from "node:test";
import assert from "node:assert/strict";

import { associateMatchPlayoffAlliance, normalizeFieldViewMatch } from "../dist/normalization/match.js";
import { archimedesSf13m1TbaMatch } from "../dist/fixtures/archimedes-sf13m1.js";

const sources = {};
const alliance = (overrides = {}) => ({
  event_key: "2026arc",
  name: "Alliance 1",
  picks: ["frc7407", "frc5940", "frc9470"],
  declines: [],
  status: {
    playoff_type: "bracket",
    level: "sf",
    record: null,
    current_level_record: null,
    status: "playing",
  },
  sources,
  ...overrides,
});

test("two of three match teams identify the alliance when one selected team is replaced", () => {
  const expected = alliance();
  assert.strictEqual(
    associateMatchPlayoffAlliance(["frc7407", "frc5940", "frc9999"], [expected]),
    expected,
  );
});

test("both incoming and outgoing backup teams remain alliance members", () => {
  const expected = alliance({
    backup: { in: "frc9999", out: "frc9470" },
  });
  assert.strictEqual(
    associateMatchPlayoffAlliance(["frc7407", "frc5940", "frc9999"], [expected]),
    expected,
  );
  assert.strictEqual(
    associateMatchPlayoffAlliance(["frc7407", "frc5940", "frc9470"], [expected]),
    expected,
  );
});

test("one matching team is insufficient and ambiguous matches remain unresolved", () => {
  const first = alliance();
  const second = alliance({
    name: "Alliance 2",
    picks: ["frc7407", "frc1111", "frc2222"],
  });
  assert.equal(
    associateMatchPlayoffAlliance(["frc7407", "frc3333", "frc4444"], [first]),
    null,
  );
  assert.equal(
    associateMatchPlayoffAlliance(["frc7407", "frc5940", "frc1111"], [first, second]),
    null,
  );
});

test("match normalization distinguishes unresolved, non-playoff, and unresolved playoff associations", () => {
  const unresolved = normalizeFieldViewMatch({
    tba_match: archimedesSf13m1TbaMatch,
    sources,
  });
  assert.equal("playoff_alliances" in unresolved, false);

  const knownNoAlliances = normalizeFieldViewMatch({
    tba_match: archimedesSf13m1TbaMatch,
    tba_playoff_alliances: [],
    sources,
  });
  assert.deepEqual(knownNoAlliances.playoff_alliances, { red: null, blue: null });

  const qualification = {
    ...archimedesSf13m1TbaMatch,
    comp_level: "qm",
  };
  const knownNonPlayoff = normalizeFieldViewMatch({
    tba_match: qualification,
    sources,
  });
  assert.equal(knownNonPlayoff.playoff_alliances, null);
});
