import assert from "node:assert/strict";
import test from "node:test";
import { classifyEventLifecycle, DEFAULT_EVENT_POLLING_POLICY, eventPollingPolicy } from "../src/event-scheduler.ts";

const event = { start_date: "2026-11-17", end_date: "2026-11-19" };
const start = Date.parse("2026-11-17T00:00:00.000Z");
const end = Date.parse("2026-11-19T23:59:59.999Z");

test("default event polling policy matches the approved lifecycle intervals", () => {
  assert.deepEqual(DEFAULT_EVENT_POLLING_POLICY, {
    discoveryIntervalMs: 60 * 60_000,
    upcomingIntervalMs: 30 * 60_000,
    activeIntervalMs: 5 * 60_000,
    completedRetentionMs: 24 * 60 * 60_000,
  });
});

test("event lifecycle transitions from upcoming to active to completed to expired", () => {
  const policy = DEFAULT_EVENT_POLLING_POLICY;
  assert.equal(classifyEventLifecycle(event, start - 1, policy)?.lifecycle, "upcoming");
  assert.equal(classifyEventLifecycle(event, start, policy)?.lifecycle, "active");
  assert.equal(classifyEventLifecycle(event, end, policy)?.lifecycle, "active");
  const completed = classifyEventLifecycle(event, end + 1, policy);
  assert.equal(completed?.lifecycle, "completed");
  assert.equal(completed?.completedUntil, end + policy.completedRetentionMs);
  assert.equal(classifyEventLifecycle(event, end + policy.completedRetentionMs, policy)?.lifecycle, "expired");
});

test("invalid TBA date ranges are ignored", () => {
  assert.equal(classifyEventLifecycle({ start_date: "bad", end_date: "2026-11-19" }, start, DEFAULT_EVENT_POLLING_POLICY), null);
  assert.equal(classifyEventLifecycle({ start_date: "2026-11-20", end_date: "2026-11-19" }, start, DEFAULT_EVENT_POLLING_POLICY), null);
});

test("lifecycle intervals can be overridden with validated millisecond settings", () => {
  const policy = eventPollingPolicy({
    EVENT_DISCOVERY_INTERVAL_MS: "7200000",
    EVENT_UPCOMING_INTERVAL_MS: "900000",
    EVENT_ACTIVE_INTERVAL_MS: 120000,
    EVENT_COMPLETED_RETENTION_MS: "43200000",
  });
  assert.deepEqual(policy, {
    discoveryIntervalMs: 7_200_000,
    upcomingIntervalMs: 900_000,
    activeIntervalMs: 120_000,
    completedRetentionMs: 43_200_000,
  });
  assert.throws(() => eventPollingPolicy({ EVENT_ACTIVE_INTERVAL_MS: "0" }), /EVENT_ACTIVE_INTERVAL_MS/);
});
