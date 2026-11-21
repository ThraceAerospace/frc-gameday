import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFieldViewEventState } from "../../domain/src/normalization/event-state.ts";
import {
  buildAllianceResults,
  buildPlayoffAnalysis,
  buildQualificationAnalysis,
  buildQualificationAnomalies,
  buildReviewFindings,
  buildTeamInsights,
  buildTeamRows,
} from "../src/calculations.ts";
import {
  calculateCanonicalMatchAnalytics,
  calculateCanonicalTeamEventAnalytics,
} from "../src/canonical-match-analytics.ts";

const fixture = JSON.parse(gunzipSync(Buffer.from(
  readFileSync(new URL("./fixtures/team3461-2026-events.json.gz.b64", import.meta.url), "utf8").trim(),
  "base64",
)).toString("utf8"));

function stateFor(eventKey) {
  const source = fixture[eventKey];
  return normalizeFieldViewEventState({
    event_key: eventKey,
    tba_event: source.event,
    tba_teams: source.teams,
    tba_event_oprs: source.oprs,
    tba_event_rankings: source.rankings,
    tba_matches: source.matches,
    statbotics_matches: source.statbotics_matches,
    sources: {
      event: {}, teams: {}, event_teams: {}, matches: {},
      playoff_alliances: {}, rankings: {},
    },
  });
}

function analyticsRecords(state) {
  return state.matches.map((match) => {
    const pre_epas = {};
    const epas = {};
    for (const team of [...match.teams.red, ...match.teams.blue]) {
      if (team.team_number === undefined) continue;
      const key = String(team.team_number);
      if (team.pre_epa) pre_epas[key] = team.pre_epa;
      if (team.epa) epas[key] = team.epa;
    }
    const prediction = match.predictions.statbotics;
    const statbotics = Object.keys(pre_epas).length || Object.keys(epas).length || prediction
      ? { key: match.key, pre_epas, epas, ...(prediction ? { pred: prediction } : {}) }
      : null;
    return { match, statbotics, statboticsStatus: statbotics ? "ready" : "unavailable" };
  });
}

for (const [eventKey, expectedAppearances] of [["2026cthar", 15], ["2026mawne", 14]]) {
  test(`2026 historical ${eventKey} Team 3461 analytics preserve calculation parity`, async () => {
    const state = stateFor(eventKey);
    const records = analyticsRecords(state);
    const source = fixture[eventKey];
    assert.equal(state.matches.length, expectedAppearances);
    assert.equal(records.filter((record) => record.statboticsStatus === "ready").length, expectedAppearances);
    assert.equal(new Set(state.matches.map((match) => match.key)).size, expectedAppearances);

    const directAllianceResults = buildAllianceResults(records, state.event.playoff_type);
    const directQualification = buildQualificationAnalysis(
      records, state.matches, directAllianceResults, state.event.playoff_type,
    );
    const directAnomalies = buildQualificationAnomalies(
      records, directAllianceResults, state.event.playoff_type,
    );
    const directPlayoffs = buildPlayoffAnalysis(directAllianceResults, null);
    const directFindings = buildReviewFindings(records, directAllianceResults);

    const eventResult = await calculateCanonicalMatchAnalytics(state);
    assert.deepEqual(
      eventResult.analytics.alliance_results,
      directAllianceResults.map((item) => ({
        match_key: item.matchKey, match_label: item.matchLabel,
        competition_level: item.compLevel, alliance: item.color,
        team_keys: item.teamKeys, predicted_score: item.predicted,
        actual_score: item.actual, score_residual: item.residual,
        pre_match_epa_total: item.preEpaTotal, winner: item.winner, outcome: item.outcome,
      })),
    );
    assert.equal(eventResult.analytics.qualification.prediction_calibration.match_count, directQualification.predictionCalibration.matchCount);
    assert.equal(eventResult.analytics.qualification.prediction_calibration.correct_count, directQualification.predictionCalibration.correctCount);
    assert.equal(eventResult.analytics.qualification.score_prediction.mean_absolute_error, directQualification.scorePrediction.meanAbsoluteError);
    assert.equal(eventResult.analytics.qualification.score_prediction.mean_residual, directQualification.scorePrediction.meanResidual);
    assert.equal(eventResult.analytics.qualification_anomalies.length, directAnomalies.length);
    assert.equal(eventResult.analytics.playoffs.match_count, directPlayoffs.matchCount);
    assert.equal(eventResult.analytics.playoffs.alliance_count, directPlayoffs.allianceCount);
    assert.equal(eventResult.analytics.findings.length, directFindings.length);

    const directRows = buildTeamRows(state.teams, source.oprs, records);
    const directInsights = buildTeamInsights(
      records, directAllianceResults, directRows, state.rankings, state.event.playoff_type,
    );
    const directTeam = directRows.find((row) => row.teamNumber === 3461);
    const directInsight = directInsights.find((item) => item.teamNumber === 3461);
    assert.ok(directTeam);
    assert.ok(directInsight);

    const teamResult = await calculateCanonicalTeamEventAnalytics(
      state,
      { event_key: eventKey, team_key: "frc3461", sources: {} },
    );
    assert.equal(teamResult.analytics.performance.matches_seen, expectedAppearances);
    assert.equal(teamResult.analytics.match_evidence.length, expectedAppearances);
    assert.equal(teamResult.analytics.performance.epa, directTeam.epa);
    assert.equal(teamResult.analytics.performance.auto_epa, directTeam.autoEpa);
    assert.equal(teamResult.analytics.performance.teleop_epa, directTeam.teleopEpa);
    assert.equal(teamResult.analytics.performance.endgame_epa, directTeam.endgameEpa);
    assert.deepEqual(teamResult.analytics.summary, directInsight.summary);
    assert.equal(teamResult.analytics.review_matches.length, directInsight.reviewMatches.length);
  });
}
