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
  buildSeasonAwareTeamInsights,
  buildTeamInsights,
  buildTeamRows,
} from "../src/calculations.ts";
import {
  calculateCanonicalMatchAnalytics,
  calculateCanonicalTeamEventAnalytics,
} from "../src/canonical-match-analytics.ts";

const fixture = JSON.parse(gunzipSync(Buffer.from(
  [1, 2].map((part) => readFileSync(new URL(`./fixtures/team3461-full-2026-events.part${part}.b64`, import.meta.url), "utf8").trim()).join(""),
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

for (const [eventKey, expectedEventMatches, expectedAppearances] of [["2026cthar", 89, 15], ["2026mawne", 91, 14]]) {
  test(`2026 historical ${eventKey} Team 3461 analytics preserve calculation parity`, async () => {
    const state = stateFor(eventKey);
    const records = analyticsRecords(state);
    const source = fixture[eventKey];
    assert.equal(state.matches.length, expectedEventMatches);
    assert.equal(records.filter((record) => record.statboticsStatus === "ready").length, expectedEventMatches);
    assert.equal(new Set(state.matches.map((match) => match.key)).size, expectedEventMatches);

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

    const directRows = buildTeamRows(state.teams, source.oprs ?? null, records);
    const directInsights = buildTeamInsights(
      records, directAllianceResults, directRows, state.rankings ?? null, state.event.playoff_type,
    );
    const directTeam = directRows.find((row) => row.teamNumber === 3461);
    const directInsight = directInsights.find((item) => item.teamNumber === 3461);
    const comparisonInput = {
      state: "complete",
      team_count: 1,
      total_team_event_records: 2,
      processed_team_event_records: 2,
      unavailable_team_event_records: 0,
      discovery_pending_teams: 0,
      updated_at: 1_780_000_000_000,
      records: [
        {
          team_number: 3461,
          event: { event_key: "2026mawne", event_name: "NE District Western NE Event", short_name: "Western NE", start_date: "2026-03-13" },
          epa_total: 14.7, epa_unitless: 1422,
          breakdown: { auto_epa: 4.17, teleop_epa: 11.72, endgame_epa: -1.18 },
          wins: 4, losses: 10, ties: 0, match_count: 14, fetched_at: 1_780_000_000_000, status: "ready",
        },
        {
          team_number: 3461,
          event: { event_key: "2026cthar", event_name: "NE District Hartford Event", short_name: "Hartford", start_date: "2026-03-27" },
          epa_total: 45.72, epa_unitless: 1505,
          breakdown: { auto_epa: 7.66, teleop_epa: 25.63, endgame_epa: 12.43 },
          wins: 8, losses: 7, ties: 0, match_count: 15, fetched_at: 1_780_000_000_000, status: "ready",
        },
      ],
    };
    const comparisonInputForCalculations = {
      state: comparisonInput.state,
      teamCount: comparisonInput.team_count,
      totalTeamEventRecords: comparisonInput.total_team_event_records,
      processedTeamEventRecords: comparisonInput.processed_team_event_records,
      unavailableTeamEventRecords: comparisonInput.unavailable_team_event_records,
      discoveryPendingTeams: comparisonInput.discovery_pending_teams,
      updatedAt: comparisonInput.updated_at,
      records: comparisonInput.records.map((item) => ({
        teamNumber: item.team_number,
        event: { key: item.event.event_key, name: item.event.event_name, short_name: item.event.short_name, startDate: item.event.start_date },
        epaTotal: item.epa_total, epaUnitless: item.epa_unitless, breakdown: item.breakdown,
        wins: item.wins, losses: item.losses, ties: item.ties, matches: item.match_count,
        fetchedAt: item.fetched_at, status: item.status,
      })),
    };
    const directSeasonInsights = eventKey === "2026cthar"
      ? buildSeasonAwareTeamInsights(
          records, directAllianceResults, directRows, state.rankings ?? null,
          comparisonInputForCalculations, eventKey, state.event.start_date, state.event.playoff_type,
        )
      : null;
    const directSeasonInsight = directSeasonInsights?.find((item) => item.teamNumber === 3461);
    assert.ok(directTeam);
    assert.ok(directInsight);
    const expectedInsight = directSeasonInsight ?? directInsight;

    const targetTeamState = { event_key: eventKey, team_key: "frc3461", sources: {} };
    const teamResult = await calculateCanonicalTeamEventAnalytics(
      state,
      targetTeamState,
      [],
      eventKey === "2026cthar" ? comparisonInput : undefined,
    );
    assert.equal(teamResult.analytics.performance.matches_seen, expectedAppearances);
    assert.equal(teamResult.analytics.match_evidence.length, expectedAppearances);
    assert.equal(teamResult.analytics.performance.epa, directTeam.epa);
    assert.equal(teamResult.analytics.performance.auto_epa, directTeam.autoEpa);
    assert.equal(teamResult.analytics.performance.teleop_epa, directTeam.teleopEpa);
    assert.equal(teamResult.analytics.performance.endgame_epa, directTeam.endgameEpa);
    assert.deepEqual(teamResult.analytics.summary, expectedInsight.summary);
    assert.equal(teamResult.analytics.review_matches.length, directInsight.reviewMatches.length);
    if (eventKey === "2026cthar") {
      assert.ok(directSeasonInsight?.seasonComparison);
      assert.equal(teamResult.analytics.season_comparison.change, 31.02);
      assert.equal(teamResult.analytics.season_comparison.prior_event.event_key, "2026mawne");
      assert.equal(teamResult.analytics.season_comparison.prior_epa, 14.7);
      assert.equal(teamResult.analytics.season_comparison.current_epa, 45.72);
      assert.equal(teamResult.analytics.season_comparison.change, directSeasonInsight.seasonComparison.change);
      assert.equal(teamResult.analytics.season_comparison.comparison_size, directSeasonInsight.seasonComparison.comparisonSize);
    } else {
      assert.equal(teamResult.analytics.season_comparison, null);
    }
  });
}
