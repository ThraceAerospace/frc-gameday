import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFieldViewDistrictDirectory,
  normalizeFieldViewDistrictSnapshot,
} from "../dist/normalization/district.js";

const retrieved = "2026-11-20T12:00:00.000Z";
const sources = {
  tba_district: { status: "available", retrieved_at: retrieved, validator: '"district-v1"' },
  tba_district_teams: { status: "available", retrieved_at: retrieved },
  tba_district_events: { status: "available", retrieved_at: retrieved },
  tba_district_rankings: { status: "available", retrieved_at: retrieved },
  tba_district_advancement: { status: "unavailable", retrieved_at: null },
};

test("district directory retains unchanged provider records and attaches collection provenance", () => {
  const providerDistricts = [
    { abbreviation: "ne", display_name: "New England", key: "2026ne", year: 2026 },
    { abbreviation: "fim", display_name: "Michigan", key: "2026fim", year: 2026 },
  ];
  const directory = normalizeFieldViewDistrictDirectory({
    year: 2026,
    tba_districts: providerDistricts,
    sources: { tba_districts: { status: "available", retrieved_at: retrieved } },
  });
  assert.deepEqual(directory.districts.map(({ sources: _sources, ...district }) => district), providerDistricts);
  assert.equal(directory.districts[0].sources.tba_districts.status, "available");
  assert.deepEqual(JSON.parse(JSON.stringify(directory)), directory);
});

test("district snapshot composes independent resources without changing their values", () => {
  const district = { abbreviation: "ne", display_name: "New England", key: "2026ne", year: 2026 };
  const teams = [{ key: "frc3461", team_number: 3461, nickname: null }];
  const events = [{ key: "2026cthar", name: "Connecticut", start_date: "2026-03-01" }];
  const rankings = [{ team_key: "frc3461", rank: 1, point_total: 42.5 }];
  const advancement = { advancement: [], cmp: null };
  const snapshot = normalizeFieldViewDistrictSnapshot({
    district_key: "2026ne", year: 2026,
    tba_district: district, tba_teams: teams, tba_events: events,
    tba_rankings: rankings, tba_advancement: advancement, sources,
  });

  assert.deepEqual(snapshot.district, { ...district, sources: { tba_district: sources.tba_district } });
  assert.strictEqual(snapshot.teams, teams);
  assert.strictEqual(snapshot.events, events);
  assert.strictEqual(snapshot.rankings, rankings);
  assert.strictEqual(snapshot.advancement, advancement);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test("district snapshot distinguishes unacquired, explicit null, and empty resources", () => {
  const missing = normalizeFieldViewDistrictSnapshot({
    district_key: "2026ne", year: 2026, sources,
  });
  assert.equal("district" in missing, false);
  assert.equal("teams" in missing, false);
  assert.equal("events" in missing, false);

  const explicitNull = normalizeFieldViewDistrictSnapshot({
    district_key: "2026ne", year: 2026,
    tba_district: null, tba_teams: null, tba_events: null, sources,
  });
  assert.equal(explicitNull.district, null);
  assert.equal(explicitNull.teams, null);
  assert.equal(explicitNull.events, null);

  const empty = normalizeFieldViewDistrictSnapshot({
    district_key: "2026ne", year: 2026,
    tba_teams: [], tba_events: [], tba_rankings: [], sources,
  });
  assert.deepEqual(empty.teams, []);
  assert.deepEqual(empty.events, []);
  assert.deepEqual(empty.rankings, []);
});

test("district normalization rejects mismatched year and identity", () => {
  assert.throws(() => normalizeFieldViewDistrictDirectory({
    year: 2026,
    tba_districts: [{ key: "2025ne", year: 2025 }],
    sources: {},
  }), /different year/);
  assert.throws(() => normalizeFieldViewDistrictSnapshot({
    district_key: "2026ne", year: 2026,
    tba_district: { key: "2026fim", year: 2026 },
    sources: {},
  }), /does not match/);
});
