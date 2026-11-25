import test from "node:test";
import assert from "node:assert/strict";
import { selectPollingCandidates } from "../src/polling-policy.ts";

const now = Date.parse("2026-11-24T18:00:00Z");
const events = [
  { key: "2026late", start_date: "2026-11-20", end_date: "2026-11-25", timezone: "America/New_York" },
  { key: "2026soon", start_date: "2026-11-25", end_date: "2026-11-27", timezone: "America/New_York" },
  { key: "2026done", start_date: "2026-11-22", end_date: "2026-11-23", timezone: "America/New_York" },
  { key: "2026past", start_date: "2026-11-01", end_date: "2026-11-02", timezone: "America/New_York" },
  { key: "2026bad", start_date: "2026-11-25", end_date: "2026-11-27", timezone: "Not/A_Timezone" },
];

test("selects only registered active events for recurring polling", () => {
  const selected = selectPollingCandidates(
    events,
    new Set(["2026late", "2026soon", "2026done", "2026past", "2026bad"]),
    now,
  );
  assert.deepEqual(selected.map((item) => [item.event.key, item.lifecycle]), [
    ["2026late", "active"],
  ]);
});

test("does not poll upcoming, completed, expired, or invalid-timezone events", () => {
  const selected = selectPollingCandidates(events, new Set(events.map((event) => event.key)), now);
  assert.deepEqual(selected.map((item) => item.event.key), ["2026late"]);
});

test("does not initialize or poll unregistered active events", () => {
  const selected = selectPollingCandidates(events, new Set(["2026soon"]), now);
  assert.deepEqual(selected, []);
});
