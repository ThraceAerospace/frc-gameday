import test from "node:test";
import assert from "node:assert/strict";
import { classifyEventThisWeek, isValidEventLifecycleInput, lifecycleFor } from "../../src/jobs/calendar.ts";

test("classifies the Monday-Sunday week using the event timezone", () => {
  const event = { start_date: "2026-11-22", end_date: "2026-11-23", timezone: "America/Los_Angeles" };
  // 04:30 UTC Monday is still Sunday evening in Los Angeles.
  const result = classifyEventThisWeek(event, Date.parse("2026-11-23T04:30:00Z"));
  assert.deepEqual(result, {
    localDate: "2026-11-22",
    weekStart: "2026-11-16",
    weekEnd: "2026-11-22",
    isThisWeek: true,
  });
});

test("treats event start and end dates as inclusive", () => {
  const event = { start_date: "2026-11-23", end_date: "2026-11-29", timezone: "UTC" };
  const result = classifyEventThisWeek(event, Date.parse("2026-11-29T12:00:00Z"));
  assert.equal(result?.isThisWeek, true);
  assert.equal(result?.weekEnd, "2026-11-29");
});

test("handles calendar-year boundaries without relying on the UTC year", () => {
  const event = { start_date: "2027-01-01", end_date: "2027-01-02", timezone: "Pacific/Kiritimati" };
  const result = classifyEventThisWeek(event, Date.parse("2026-12-31T12:30:00Z"));
  assert.equal(result?.localDate, "2027-01-01");
  assert.equal(result?.isThisWeek, true);
});

test("rejects malformed dates and invalid IANA timezones", () => {
  assert.equal(classifyEventThisWeek({
    start_date: "2026-02-30", end_date: "2026-03-01", timezone: "UTC",
  }, Date.now()), null);
  assert.equal(classifyEventThisWeek({
    start_date: "2026-11-22", end_date: "2026-11-23", timezone: "Not/A_Timezone",
  }, Date.now()), null);
});

test("validates lifecycle inputs before coverage audits expect a runtime", () => {
  assert.equal(isValidEventLifecycleInput({
    start_date: "2026-11-23", end_date: "2026-11-25", timezone: "America/New_York",
  }), true);
  assert.equal(isValidEventLifecycleInput({
    start_date: "2026-02-30", end_date: "2026-03-01", timezone: "UTC",
  }), false);
  assert.equal(isValidEventLifecycleInput({
    start_date: "2026-11-23", end_date: "2026-11-25", timezone: "Not/A_Timezone",
  }), false);
});

test("determines lifecycle using the event's local calendar date", () => {
  const event = { start_date: "2026-11-23", end_date: "2026-11-25", timezone: "America/Los_Angeles" };
  assert.equal(lifecycleFor(event, Date.parse("2026-11-23T07:30:00Z")).lifecycle, "upcoming");
  assert.equal(lifecycleFor(event, Date.parse("2026-11-24T12:00:00Z")).lifecycle, "active");
  assert.equal(lifecycleFor(event, Date.parse("2026-11-28T12:00:00Z")).lifecycle, "expired");
  const duringRetention = lifecycleFor(event, Date.parse("2026-11-26T12:00:00Z"));
  assert.equal(duringRetention.lifecycle, "completed");
  assert.equal(typeof duringRetention.completedUntil, "number");
});
