import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcilePolledEndpoint,
  reconcileWebhookEndpoint,
} from "../../src/runtime/reconciliation.ts";

test("poll reconciliation retains completed results when TBA returns a regressed match", () => {
  const endpoint = "/event/2026test/matches";
  const completed = {
    key: "2026test_qm1",
    actual_time: 100,
    alliances: { red: { score: 120 }, blue: { score: 90 } },
  };
  const result = reconcilePolledEndpoint(endpoint, [completed], [
    { key: "2026test_qm1", actual_time: null, alliances: { red: { score: -1 }, blue: { score: -1 } } },
    { key: "2026test_qm2", actual_time: null },
  ]);
  assert.equal(result[0], completed);
  assert.equal(result[1].key, "2026test_qm2");
});

test("poll reconciliation retains cached matches omitted from a partial response", () => {
  const result = reconcilePolledEndpoint("/event/2026test/matches",
    [{ key: "qm1" }, { key: "qm2" }],
    [{ key: "qm1", actual_time: 10 }]);
  assert.deepEqual(result.map((match) => match.key), ["qm1", "qm2"]);
});

test("non-match endpoint payloads pass through unchanged", () => {
  const fetched = { name: "Event", event_code: "test" };
  assert.equal(reconcilePolledEndpoint("/event/2026test", { old: true }, fetched), fetched);
});

test("match webhook patches the matching provider record without dropping other records", () => {
  const previous = { key: "qm1", alliances: { red: { score: -1 } }, time: 10 };
  const other = { key: "qm2" };
  const result = reconcileWebhookEndpoint("/event/2026test/matches",
    [previous, other], { key: "qm1", time: 20, predicted_time: 30 });
  assert.deepEqual(result, [
    { key: "qm1", alliances: { red: { score: -1 } }, time: 20, predicted_time: 30 },
    other,
  ]);
});

test("a new match webhook record is appended with canonical match fields", () => {
  const incoming = { key: "qm3", alliances: { red: { score: 100 } } };
  const result = reconcileWebhookEndpoint("/event/2026test/matches", [], incoming);
  assert.deepEqual(result[0], incoming);
});

test("first match webhook initializes event match state as an array", () => {
  const incoming = { key: "qm1", event_key: "2026test" };
  assert.deepEqual(
    reconcileWebhookEndpoint("/event/2026test/matches", null, incoming),
    [incoming],
  );
});

test("webhook Match alliance teams are normalized to canonical team_keys", () => {
  const result = reconcileWebhookEndpoint("/event/2026test/matches", [], {
    key: "2026test_qm1",
    event_key: "2026test",
    alliances: {
      red: { score: 100, teams: ["frc1", "frc2", "frc3"] },
      blue: { score: 90, teams: ["frc4", "frc5", "frc6"] },
    },
  });
  assert.deepEqual(result[0].alliances.red, { score: 100, team_keys: ["frc1", "frc2", "frc3"] });
  assert.deepEqual(result[0].alliances.blue, { score: 90, team_keys: ["frc4", "frc5", "frc6"] });
});

test("partial webhook alliance updates preserve omitted team identities and opposing alliance", () => {
  const current = {
    key: "2026test_qm1",
    alliances: {
      red: { team_keys: ["frc1", "frc2", "frc3"], score: -1 },
      blue: { team_keys: ["frc4", "frc5", "frc6"], score: -1 },
    },
  };
  const result = reconcileWebhookEndpoint("/event/2026test/matches", [current], {
    key: "2026test_qm1",
    alliances: { red: { score: 100 } },
  });
  assert.deepEqual(result[0].alliances.red, { team_keys: ["frc1", "frc2", "frc3"], score: 100 });
  assert.deepEqual(result[0].alliances.blue, current.alliances.blue);
});
