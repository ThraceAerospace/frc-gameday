import test from "node:test";
import assert from "node:assert/strict";
import { selectPollingCandidates } from "../src/polling-policy.ts";

const now = Date.parse("2026-11-24T18:00:00Z");
const events = [
  { key: "2026late", start_date: "2026-11-20", end_date: "2026-11-25", timezone: "America/New_York" },
  { key: "2026soon", start_date: "2026-11-25", end_date: "2026-11-27", timezone: "America/New_York" },
  { key: "2026past", start_date: "2026-11-01", end_date: "2026-11-02", timezone: "America/New_York" },
  { key: "2026bad", start_date: "2026-11-25", end_date: "2026-11-27", timezone: "Not/A_Timezone" },
];

test("selects only registered upcoming and active events, active first", () => {
  const selected = selectPollingCandidates(events, new Set(["2026late", "2026soon", "2026past", "2026bad"]), now);
  assert.deepEqual(selected.map((item) => [item.event.key, item.lifecycle]), [
    ["2026late", "active"],
    ["2026soon", "upcoming"],
  ]);
});

test("does not initialize or poll unregistered discovery entries", () => {
  const selected = selectPollingCandidates(events, new Set(["2026soon"]), now);
  assert.deepEqual(selected.map((item) => item.event.key), ["2026soon"]);
});
