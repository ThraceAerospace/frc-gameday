import test from "node:test";
import assert from "node:assert/strict";

import { normalizeFieldViewTeamSeason } from "../dist/normalization/team-season.js";

test("team-season normalization correlates Statbotics team by TBA team_number", () => {
  const statboticsTeamYear = {
    team: 7407,
    year: 2026,
    name: "Shark Attack",
    country: null,
    epa: { total_points: 42.5 },
  };
  const result = normalizeFieldViewTeamSeason({
    team_key: "frc7407",
    team_number: 7407,
    year: 2026,
    statbotics_team_year: statboticsTeamYear,
    sources: { tba_team: { status: "available", retrieved_at: "2026-05-01T00:00:00.000Z" }, statbotics_team_year: { status: "available", retrieved_at: "2026-05-01T00:00:00.000Z" } },
  });

  assert.deepEqual(result, {
    team_key: "frc7407",
    team_number: 7407,
    year: 2026,
    statbotics: statboticsTeamYear,
    sources: { tba_team: { status: "available", retrieved_at: "2026-05-01T00:00:00.000Z" }, statbotics_team_year: { status: "available", retrieved_at: "2026-05-01T00:00:00.000Z" } },
  });
  assert.strictEqual(result.statbotics, statboticsTeamYear);
  assert.equal(result.statbotics.country, null);
});

test("team-season normalization rejects a mismatched Statbotics team value", () => {
  assert.throws(
    () => normalizeFieldViewTeamSeason({
      team_key: "frc7407",
      team_number: 7407,
      year: 2026,
      statbotics_team_year: { team: 5940, year: 2026 },
      sources: {},
    }),
    /does not match TBA team number 7407/,
  );
});

test("team-season domain object survives JSON transport round-trip", () => {
  const season = normalizeFieldViewTeamSeason({
    team_key: "frc7407",
    team_number: 7407,
    year: 2026,
    statbotics_team_year: {
      team: 7407,
      year: 2026,
      country: null,
      epa: { total_points: 42.5 },
    },
    sources: { tba_team: { status: "available", retrieved_at: "2026-05-01T00:00:00.000Z" }, statbotics_team_year: { status: "available", retrieved_at: "2026-05-01T00:00:00.000Z" } },
  });

  const received = JSON.parse(JSON.stringify(season));
  assert.deepEqual(received, season);
  assert.equal(received.statbotics.country, null);
  assert.equal(received.team_number, 7407);
  assert.equal("statbotics_team_id" in received, false);
});
