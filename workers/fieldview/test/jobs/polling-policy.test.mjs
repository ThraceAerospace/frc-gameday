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

test("selects registered upcoming and active this-week events for competition hydration", () => {
  const selected = selectPollingCandidates(
    events,
    new Set(["2026late", "2026soon", "2026done", "2026past", "2026bad"]),
    now,
  );
  assert.deepEqual(selected.map((item) => [item.event.key, item.lifecycle]), [
    ["2026late", "active"],
    ["2026soon", "upcoming"],
  ]);
});

test("does not poll completed, expired, or invalid-timezone events", () => {
  const selected = selectPollingCandidates(events, new Set(events.map((event) => event.key)), now);
  assert.deepEqual(selected.map((item) => item.event.key), ["2026late", "2026soon"]);
});

test("does not initialize or poll unregistered this-week events", () => {
  const selected = selectPollingCandidates(events, new Set(["2026soon"]), now);
  assert.deepEqual(selected.map((item) => [item.event.key, item.lifecycle]), [["2026soon", "upcoming"]]);
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


test("initial event acquisition selects a bounded rotating slice of non-expired discovered events", async () => {
  const { selectInitialEventCandidates, MAX_INITIAL_EVENT_ACQUISITIONS_PER_RUN } =
    await import("../../src/jobs/polling-policy.ts");
  const discovered = [
    { key: "2026expired", start_date: "2026-11-01", end_date: "2026-11-02", timezone: "UTC" },
    { key: "2026upcoming", start_date: "2026-11-25", end_date: "2026-11-26", timezone: "UTC" },
    { key: "2026active", start_date: "2026-11-20", end_date: "2026-11-27", timezone: "UTC" },
    { key: "2026completed", start_date: "2026-11-20", end_date: "2026-11-24", timezone: "UTC" },
    { key: "2026invalid", start_date: "2026-11-25", end_date: "2026-11-26", timezone: "Not/A_Timezone" },
    { key: "2026more", start_date: "2026-11-26", end_date: "2026-11-27", timezone: "UTC" },
  ];
  const current = Date.parse("2026-11-26T12:00:00Z");
  const first = selectInitialEventCandidates(discovered, current, MAX_INITIAL_EVENT_ACQUISITIONS_PER_RUN, 0);
  assert.equal(first.length, 2);
  assert.equal(first.some((item) => item.key === "2026expired"), false);
  assert.equal(first.some((item) => item.key === "2026invalid"), false);
  const second = selectInitialEventCandidates(discovered, current, 2, 1);
  assert.notDeepEqual(second.map((item) => item.key), first.map((item) => item.key),
    "rotation advances the bounded slice when the candidate count is not divisible by the limit");
  assert.equal(new Set([...first, ...second].map((item) => item.key)).size, 3,
    "rotation covers every eligible event across successive runs");
});

test("initial event acquisition excludes entities already handled by active polling", async () => {
  const { selectInitialEventCandidates } = await import("../../src/jobs/polling-policy.ts");
  const discovered = [
    { key: "2026a", start_date: "2026-11-20", end_date: "2026-11-27", timezone: "UTC" },
    { key: "2026b", start_date: "2026-11-21", end_date: "2026-11-27", timezone: "UTC" },
    { key: "2026c", start_date: "2026-11-22", end_date: "2026-11-27", timezone: "UTC" },
  ];
  const selected = selectInitialEventCandidates(
    discovered, Date.parse("2026-11-26T12:00:00Z"), 2, 0, new Set(["2026a"]),
  );
  assert.deepEqual(selected.map((item) => item.key), ["2026b", "2026c"]);
});
