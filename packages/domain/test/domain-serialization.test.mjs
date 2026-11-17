import test from "node:test";
import assert from "node:assert/strict";

const roundTrip = (value) => JSON.parse(JSON.stringify(value));

test("FieldViewTeam preserves provider values, explicit nulls, and provenance", () => {
  const team = {
    key: "frc7407",
    team_number: 7407,
    nickname: "Shark Attack",
    city: null,
    school_name: "Example High School",
    sources: {
      tba_team: {
        status: "available",
        retrieved_at: "2026-05-01T00:00:00.000Z",
        source_updated_at: null,
      },
    },
  };

  const received = roundTrip(team);
  assert.deepEqual(received, team);
  assert.equal(received.city, null);
  assert.equal("website" in received, false);
  assert.equal(received.sources.tba_team.source_updated_at, null);
});

test("FieldViewEvent preserves timestamps, nullable provider fields, and provenance", () => {
  const event = {
    key: "2026arc",
    name: "Archimedes Championship",
    year: 2026,
    timezone: "America/Houston",
    start_date: "2026-05-01",
    end_date: "2026-05-04",
    website: null,
    playoff_type: 8,
    sources: {
      tba_event: {
        status: "stale",
        retrieved_at: "2026-05-02T00:00:00.000Z",
        validator: "etag-example",
      },
    },
  };

  const received = roundTrip(event);
  assert.deepEqual(received, event);
  assert.equal(received.website, null);
  assert.equal(received.timezone, "America/Houston");
  assert.equal(received.sources.tba_event.status, "stale");
  assert.equal("webcast" in received, false);
});

test("FieldViewPlayoffAlliance preserves backup substitution and nullable advancement data", () => {
  const alliance = {
    event_key: "2026arc",
    name: "Alliance 4",
    picks: ["frc7407", "frc5940", "frc9470"],
    declines: [],
    backup: { in: "frc10133", out: "frc9470" },
    status: {
      playoff_type: 0,
      level: "sf",
      record: null,
      current_level_record: null,
      status: "playing",
    },
    sources: {
      tba_playoff_alliances: {
        status: "available",
        retrieved_at: "2026-05-02T00:00:00.000Z",
      },
      tba_playoff_advancement: {
        status: "unavailable",
        retrieved_at: null,
      },
    },
  };

  const received = roundTrip(alliance);
  assert.deepEqual(received, alliance);
  assert.deepEqual(received.backup, { in: "frc10133", out: "frc9470" });
  assert.equal(received.status.record, null);
  assert.equal(received.sources.tba_playoff_advancement.status, "unavailable");
  assert.equal(received.sources.tba_playoff_advancement.retrieved_at, null);
});

test("source metadata keeps absent, null, unavailable, stale, and failed states distinct", () => {
  const metadata = {
    tba_team: { status: "available", retrieved_at: "2026-05-01T00:00:00.000Z" },
    tba_event: { status: "stale", retrieved_at: "2026-04-30T00:00:00.000Z" },
    tba_match: { status: "unavailable", retrieved_at: null },
    statbotics_match: { status: "failed", retrieved_at: null },
    tba_event_oprs: {
      status: "available",
      retrieved_at: "2026-05-01T00:00:00.000Z",
      source_updated_at: null,
      validator: null,
    },
  };

  const received = roundTrip(metadata);
  assert.deepEqual(received, metadata);
  assert.equal("tba_playoff_alliances" in received, false);
  assert.equal(received.tba_match.retrieved_at, null);
  assert.equal(received.statbotics_match.status, "failed");
  assert.equal(received.tba_event_oprs.source_updated_at, null);
  assert.equal(received.tba_event_oprs.validator, null);
});
