import test from "node:test";
import assert from "node:assert/strict";

import { normalizeFieldViewTeamSeason } from "../dist/normalization/team-season.js";

test("team-season normalization retains the Statbotics record and explicit identity association", () => {
  const statboticsTeamYear = {
    team: 7407,
    year: 2026,
    name: "Shark Attack",
    country: null,
    epa: { total_points: 42.5 },
  };
  const result = normalizeFieldViewTeamSeason({
    team_key: "frc7407",
    year: 2026,
    statbotics_team_id: 7407,
    statbotics_team_year: statboticsTeamYear,
  });

  assert.deepEqual(result, {
    team_key: "frc7407",
    year: 2026,
    statbotics_team_id: 7407,
    statbotics: statboticsTeamYear,
  });
  assert.strictEqual(result.statbotics, statboticsTeamYear);
  assert.equal(result.statbotics.country, null);
});

test("team-season normalization does not infer a Statbotics identity from a TBA key", () => {
  const result = normalizeFieldViewTeamSeason({
    team_key: "frc7407",
    year: 2026,
    statbotics_team_year: { team: 7407, year: 2026 },
  });

  assert.deepEqual(result, {
    team_key: "frc7407",
    year: 2026,
    statbotics: { team: 7407, year: 2026 },
  });
  assert.equal("statbotics_team_id" in result, false);
});

test("team-season domain object survives JSON transport round-trip", () => {
  const season = normalizeFieldViewTeamSeason({
    team_key: "frc7407",
    year: 2026,
    statbotics_team_id: 7407,
    statbotics_team_year: {
      team: 7407,
      year: 2026,
      country: null,
      epa: { total_points: 42.5 },
    },
  });

  const received = JSON.parse(JSON.stringify(season));
  assert.deepEqual(received, season);
  assert.equal(received.statbotics.country, null);
  assert.equal(received.statbotics_team_id, 7407);
});
