import assert from "node:assert/strict";
import test from "node:test";
import { toLegacyFRCColors } from "./legacy-compatibility.ts";

test("projects provider team colors into the existing analytics shape", () => {
  const result = toLegacyFRCColors({
    teams: {
      "3461": {
        teamNumber: 3461,
        colors: { primaryHex: "#aBcDeF", secondaryHex: "#123456", verified: true },
      },
      "254": {
        colors: { primaryHex: "#abcdef", secondaryHex: null, verified: false },
      },
    },
  });

  assert.deepEqual(result, [
    { teamNumber: 254, primaryHex: "#ABCDEF", secondaryHex: null, verified: false },
    { teamNumber: 3461, primaryHex: "#ABCDEF", secondaryHex: "#123456", verified: true },
  ]);
});

test("preserves the existing missing and invalid field semantics", () => {
  const result = toLegacyFRCColors({
    teams: {
      "3461": { colors: null },
      "0": { colors: { primaryHex: "#12345", secondaryHex: "red", verified: "yes" } },
      "-1": {},
      "not-a-team": {},
    },
  });

  assert.deepEqual(result, [
    { teamNumber: 3461, primaryHex: null, secondaryHex: null, verified: null },
  ]);
});

test("returns an empty compatibility collection when the provider has no teams", () => {
  assert.deepEqual(toLegacyFRCColors({}), []);
  assert.deepEqual(toLegacyFRCColors({ teams: {} }), []);
});
