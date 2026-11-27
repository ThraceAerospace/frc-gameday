import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { logIncompleteStateServed } from "./incompleteStateTelemetry.ts";

const eventPagePath = fileURLToPath(new URL("../../app/event/[event]/page.tsx", import.meta.url));
const teamPagePath = fileURLToPath(new URL("../../app/team/[team]/page.tsx", import.meta.url));

test("incomplete-state telemetry is structured, timestamped, and log-only", () => {
  const records = [];
  logIncompleteStateServed({
    entity_kind: "event",
    entity_key: "2026mmr",
    served_source: "tba_event_discovery",
    reason_codes: ["event_state_missing"],
    year: 2026,
  }, (message, payload) => records.push({ message, payload }), () => new Date("2026-11-27T04:30:00.000Z"));

  assert.equal(records.length, 1);
  assert.equal(records[0].message, "[FV][IncompleteStateServed]");
  assert.deepEqual(JSON.parse(records[0].payload), {
    response_state: "partial",
    entity_kind: "event",
    entity_key: "2026mmr",
    served_source: "tba_event_discovery",
    reason_codes: ["event_state_missing"],
    year: 2026,
    served: true,
    timestamp: "2026-11-27T04:30:00.000Z",
  });
});

test("event page uses published TBA discovery as a read-only fallback", async () => {
  const source = await readFile(eventPagePath, "utf8");
  assert.match(source, /getCanonicalEventDiscovery\(fallbackYear\)/);
  assert.match(source, /candidate\.key === eventKey/);
  assert.match(source, /logIncompleteStateServed\(/);
  assert.match(source, /!eventSnapshot\) logIncompleteStateServed/);
  assert.match(source, /FieldView data for this event is incomplete/);
  assert.doesNotMatch(source, /PendingSnapshotRefresh|setInterval\s*\(|router\.refresh\s*\(/);
});

test("TBA-only team page avoids event snapshot fan-out and records partial state", async () => {
  const source = await readFile(teamPagePath, "utf8");
  assert.match(source, /getCanonicalTeamDiscovery\(currentYear\)/);
  assert.match(source, /candidate\.key === teamKey/);
  assert.match(source, /hasCanonicalTeamState \? \(await mapWithConcurrency/);
  assert.match(source, /logIncompleteStateServed\(/);
  assert.match(source, /FieldView team and season data is incomplete/);
  assert.doesNotMatch(source, /PendingSnapshotRefresh|setInterval\s*\(|router\.refresh\s*\(/);
});
