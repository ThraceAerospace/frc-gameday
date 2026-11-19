import test from "node:test";
import assert from "node:assert/strict";
import { buildCanonicalSeasonCohort } from "../src/canonical-season-cohort.ts";

const event = (key, start_date, event_type = 0) => ({
  key, name: key, event_code: key.slice(4), start_date, event_type,
});
const statboticsEvent = (key, total, auto) => ({
  event: key,
  epa: { total_points: total, unitless: total / 100, breakdown: { auto_epa: auto } },
  record: { total: { wins: 4, losses: 2, ties: 0, count: 6 } },
});
const snapshot = (teamNumber, events, statbotics_events) => ({
  team_key: "frc" + teamNumber,
  year: 2026,
  sources: {
    statbotics_team_events: { status: "available", retrieved_at: "2026-03-20T12:00:00.000Z" },
  },
  events,
  statbotics_events,
});

test("canonical season cohort retains prior/current events and unavailable records without zero filling", () => {
  const target = {
    key: "2026target", name: "Target Event", event_code: "target", start_date: "2026-03-10",
  };
  const result = buildCanonicalSeasonCohort(target, [1, 2, 3], [
    snapshot(1, [
      event("2026prior", "2026-03-01"),
      event("2026target", "2026-03-10"),
      event("2026later", "2026-03-20"),
      event("2026off", "2026-02-20", 99),
    ], [
      statboticsEvent("2026prior", 50, 10),
      statboticsEvent("2026target", 60, 12),
    ]),
    snapshot(2, [
      event("2026prior", "2026-03-01"),
      event("2026target", "2026-03-10"),
    ], [statboticsEvent("2026target", 40, 8)]),
    null,
  ], 1_800_000_000_000);

  assert.equal(result.team_count, 3);
  assert.equal(result.state, "discovering");
  assert.equal(result.discovery_pending_teams, 1);
  assert.equal(result.total_team_event_records, 5);
  assert.equal(result.processed_team_event_records, 5);
  assert.equal(result.unavailable_team_event_records, 2);
  assert.deepEqual(result.records.map((record) => record.event.event_key), [
    "2026prior", "2026target", "2026prior", "2026target", "2026target",
  ]);
  assert.equal(result.records[0].epa_total, 50);
  assert.equal(result.records[1].epa_total, 60);
  assert.equal(result.records[2].status, "unavailable");
  assert.equal(result.records[2].epa_total, null);
  assert.equal(result.records[4].team_number, 3);
  assert.equal(result.records[4].status, "unavailable");
});

test("canonical season cohort marks complete only when every team history is acquired", () => {
  const target = {
    key: "2026target", name: "Target Event", event_code: "target", start_date: "2026-03-10",
  };
  const result = buildCanonicalSeasonCohort(target, [1], [
    snapshot(1, [event("2026target", "2026-03-10")], [statboticsEvent("2026target", 50, 10)]),
  ], 1_800_000_000_000);
  assert.equal(result.state, "complete");
  assert.equal(result.unavailable_team_event_records, 0);
  assert.equal(result.records[0].epa_total, 50);
});
