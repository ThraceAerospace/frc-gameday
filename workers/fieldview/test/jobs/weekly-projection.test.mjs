import assert from "node:assert/strict";
import test from "node:test";
import { buildEventsThisWeekProjection, utcWeekWindow } from "../../src/jobs/weekly-projection.ts";

const event = (key, start_date, end_date, timezone = "America/Los_Angeles") => ({
  key, start_date, end_date, timezone,
});

test("weekly projection uses the event-local Monday-Sunday week and inclusive event dates", () => {
  const evaluatedAt = Date.parse("2026-11-23T16:00:00.000Z");
  const events = [
    event("2026before", "2026-11-22", "2026-11-24"),
    event("2026inside", "2026-11-27", "2026-11-29"),
    event("2026after", "2026-11-30", "2026-12-02"),
  ];
  const projection = buildEventsThisWeekProjection(events, 2026, evaluatedAt, evaluatedAt - 1000);
  assert.deepEqual(projection.events.map((item) => item.key), ["2026before", "2026inside"]);
  assert.equal(projection.weekStart, "2026-11-23");
  assert.equal(projection.weekEnd, "2026-11-29");
  assert.equal(projection.runDate, "2026-11-23");
});

test("weekly projection preserves event records and sorts candidates by canonical key", () => {
  const evaluatedAt = Date.parse("2026-11-23T16:00:00.000Z");
  const first = { ...event("2026b", "2026-11-23", "2026-11-23"), city: "Boston", custom: { value: 1 } };
  const second = event("2026a", "2026-11-23", "2026-11-23");
  const projection = buildEventsThisWeekProjection([first, second], 2026, evaluatedAt, evaluatedAt);
  assert.deepEqual(projection.events.map((item) => item.key), ["2026a", "2026b"]);
  assert.deepEqual(projection.events[1], first);
});

test("invalid date ranges and invalid timezones are excluded", () => {
  const evaluatedAt = Date.parse("2026-11-23T16:00:00.000Z");
  const projection = buildEventsThisWeekProjection([
    event("2026valid", "2026-11-23", "2026-11-23"),
    event("2026invalid-zone", "2026-11-23", "2026-11-23", "Not/AZone"),
    event("2026reversed", "2026-11-25", "2026-11-23"),
    event("2026bad-date", "2026-02-30", "2026-03-01"),
  ], 2026, evaluatedAt, evaluatedAt);
  assert.deepEqual(projection.events.map((item) => item.key), ["2026valid"]);
});

test("UTC week identity is Monday through Sunday across year boundaries", () => {
  assert.deepEqual(utcWeekWindow(Date.parse("2027-01-01T12:00:00.000Z")), {
    weekStart: "2026-12-28", weekEnd: "2027-01-03",
  });
});
