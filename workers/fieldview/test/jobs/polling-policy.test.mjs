import test from "node:test";
import assert from "node:assert/strict";
import { selectPollingCandidates, selectBudgetedKeys, selectBudgetedItems, isEventAnalyticsRecoveryDue } from "../../src/jobs/polling-policy.ts";

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


test("bounds event polling candidates and rotates the slice between runs", () => {
  const activeEvents = Array.from({ length: 10 }, (_, index) => ({
    key: "2026event" + String(index).padStart(2, "0"),
    start_date: "2026-11-20",
    end_date: "2026-11-25",
    timezone: "UTC",
  }));
  const registered = new Set(activeEvents.map((event) => event.key));
  const first = selectPollingCandidates(activeEvents, registered, now, 4, 0);
  const second = selectPollingCandidates(activeEvents, registered, now, 4, 1);
  assert.equal(first.length, 4);
  assert.equal(second.length, 4);
  assert.equal(first.some((item) => second.some((other) => other.event.key === item.event.key)), false);
  assert.equal(new Set([...first, ...second].map((item) => item.event.key)).size, 8);
});

test("budgeted team selection is unique, bounded, and rotates deterministically", () => {
  const keys = ["frc3", "frc1", "frc2", "frc1"];
  assert.deepEqual(selectBudgetedKeys(keys, 2, 0), ["frc1", "frc2"]);
  assert.deepEqual(selectBudgetedKeys(keys, 2, 1), ["frc3", "frc1"]);
  assert.deepEqual(selectBudgetedKeys(keys, 0, 0), []);
});


test("rotates event candidates without losing lifecycle priority order", () => {
  const candidates = [
    { key: "first", start_date: "2026-11-20" },
    { key: "second", start_date: "2026-11-21" },
    { key: "third", start_date: "2026-11-22" },
    { key: "fourth", start_date: "2026-11-23" },
    { key: "fifth", start_date: "2026-11-24" },
  ];
  assert.deepEqual(selectBudgetedItems(candidates, 2, 0).map((item) => item.key), ["first", "second"]);
  assert.deepEqual(selectBudgetedItems(candidates, 2, 1).map((item) => item.key), ["third", "fourth"]);
});


test("event analytics recovery only dispatches pending, failed, or stale work when due", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  assert.equal(isEventAnalyticsRecoveryDue("pending", null, now), true);
  assert.equal(isEventAnalyticsRecoveryDue("failed", now - 1, now), true);
  assert.equal(isEventAnalyticsRecoveryDue("stale", now, now), true);
  assert.equal(isEventAnalyticsRecoveryDue("running", now - 1, now), true,
    "an interrupted running publication with an expired due time is recoverable");
  assert.equal(isEventAnalyticsRecoveryDue("running", null, now), false,
    "a running state without a durable due marker is not assumed abandoned");
  assert.equal(isEventAnalyticsRecoveryDue("pending", now + 1, now), false);
  assert.equal(isEventAnalyticsRecoveryDue("succeeded", null, now), false);
  assert.equal(isEventAnalyticsRecoveryDue("partial", null, now), false);
  assert.equal(isEventAnalyticsRecoveryDue("running", null, now), false);
  assert.equal(isEventAnalyticsRecoveryDue("pending", "invalid", now), true,
    "malformed due metadata must not strand explicitly pending work");
});
