/**
 * Calculate only the team-scoped event results. TeamRuntime calls this with
 * its own TeamEventState; EventRuntime never executes this calculation path.
 */
export function calculateCanonicalTeamEventStates(
  eventState: FieldViewEventState,
  teamStates: FieldViewTeamEventState[],
  records: AnalyticsMatch[],
  allianceResults: AllianceResult[],
  audit: FieldViewAnalyticsAudit,
  comparisonInput?: FieldViewEventTeamSeasonComparisonInput,
): FieldViewTeamEventState[] {
  const teams = (eventState.teams ?? []).map((team) => ({
    key: team.key,
    team_number: team.team_number,
    nickname: team.nickname,
    name: team.name,
  }));
  const eventTeams = eventState.event_teams ?? [];
  const oprValues: Record<string, number> = {};
  const dprValues: Record<string, number> = {};
  const ccwmValues: Record<string, number> = {};
  for (const team of eventTeams) {
    if (team.opr !== undefined) oprValues[team.team_key] = team.opr;
    if (team.dpr !== undefined) dprValues[team.team_key] = team.dpr;
    if (team.ccwm !== undefined) ccwmValues[team.team_key] = team.ccwm;
  }
  const oprs = { oprs: oprValues, dprs: dprValues, ccwms: ccwmValues };
  const teamRows = buildTeamRows(teams, oprs, records);
  const comparisonInputForInsights = comparisonInput ? {
    state: comparisonInput.state,
    teamCount: comparisonInput.team_count,
    totalTeamEventRecords: comparisonInput.total_team_event_records,
    processedTeamEventRecords: comparisonInput.processed_team_event_records,
    unavailableTeamEventRecords: comparisonInput.unavailable_team_event_records,
    discoveryPendingTeams: comparisonInput.discovery_pending_teams,
    updatedAt: comparisonInput.updated_at,
    records: comparisonInput.records.map((item) => ({
      teamNumber: item.team_number,
      event: {
        key: item.event.event_key, name: item.event.event_name,
        short_name: item.event.short_name, startDate: item.event.start_date,
      },
      epaTotal: item.epa_total, epaUnitless: item.epa_unitless,
      breakdown: item.breakdown, wins: item.wins, losses: item.losses,
      ties: item.ties, matches: item.match_count, fetchedAt: item.fetched_at,
      status: item.status,
    })),
  } : null;
  const insights = comparisonInputForInsights && eventState.event
    ? buildSeasonAwareTeamInsights(
        records, allianceResults, teamRows, eventState.rankings ?? null,
        comparisonInputForInsights, eventState.event.key, eventState.event.start_date,
        eventState.event.playoff_type,
      )
    : buildTeamInsights(records, allianceResults, teamRows, eventState.rankings ?? null, eventState.event?.playoff_type);
  const allianceResultByMatch = new Map(allianceResults.map((item) => [item.matchKey + ":" + item.color, item]));
  const team_states = teamStates.map((teamState) => {
        const row = teamRows.find((item) => item.teamKey === teamState.team_key);
        if (!row) return teamState;
        const insight = insights.find((item) => item.teamNumber === row.teamNumber);
        const epaPopulation = population("team-event-latest-epa", 1, row.epa === null ? 0 : 1);
        const contributionPopulation = population("team-event-alliance-appearances", row.matchesSeen, row.epaContributionSamples);
        const comparisonPopulation = population("event-teams-with-available-epa", teamRows.length, teamRows.filter((item) => item.epa !== null).length);
        const epaRank = row.epa === null ? null : 1 + teamRows.filter((item) => item.epa !== null && item.epa > row.epa!).length;
        const metrics: FieldViewMetricResult[] = [
          metric("epa", "team-event-epa", row.epa, "EPA", row.epa === null ? 0 : 1, epaPopulation, ["Latest observed EPA; not an event-average value."]),
          metric("auto-epa", "team-event-epa", row.autoEpa, "EPA", row.autoEpa === null ? 0 : 1, epaPopulation, ["Latest observed component EPA."]),
          metric("teleop-epa", "team-event-epa", row.teleopEpa, "EPA", row.teleopEpa === null ? 0 : 1, epaPopulation, ["Latest observed component EPA."]),
          metric("endgame-epa", "team-event-epa", row.endgameEpa, "EPA", row.endgameEpa === null ? 0 : 1, epaPopulation, ["Latest observed component EPA."]),
          metric("epa-percentile", "team-event-epa", row.epaPercentile, "percentile", row.epa === null ? 0 : 1, epaPopulation, ["Compared with event teams that have an available EPA value."], {
            population: comparisonPopulation,
            rank_position: epaRank,
            percentile: row.epaPercentile,
          }),
          metric("epa-contribution-percent", "team-epa-contribution-share", row.epaContributionPercent, "percent", row.epaContributionSamples, contributionPopulation, ["Mean share of eligible three-team alliance pre-match EPA totals; not measured robot-level scoring contribution."]),
          metric("matches-seen", "team-event-match-appearances", row.matchesSeen, "matches", row.matchesSeen, population("team-event-match-appearances", row.matchesSeen, row.matchesSeen), ["Counts roster appearances, including matches that are not yet scored."]),
        ];
        const matchEvidence: FieldViewTeamMatchEvidence[] = records.flatMap((record) => {
          const match = record.match;
          const alliance = match.alliances.red.team_keys.includes(teamState.team_key) ? "red" as const
            : match.alliances.blue.team_keys.includes(teamState.team_key) ? "blue" as const : null;
          if (!alliance) return [];
          const opponentAlliance = alliance === "red" ? "blue" as const : "red" as const;
          const own = allianceResultByMatch.get(match.key + ":" + alliance);
          const opponent = allianceResultByMatch.get(match.key + ":" + opponentAlliance);
          const redProbability = record.statbotics?.pred?.red_win_prob;
          const winProbability = typeof redProbability === "number" && redProbability >= 0 && redProbability <= 1
            ? alliance === "red" ? redProbability : 1 - redProbability : null;
          const ownPre = record.statbotics?.pre_epas?.[String(row.teamNumber)]?.epa;
          const ownPost = record.statbotics?.epas?.[String(row.teamNumber)]?.epa;
          const preEpa = typeof ownPre === "number" && Number.isFinite(ownPre) ? ownPre : null;
          const postEpa = typeof ownPost === "number" && Number.isFinite(ownPost) ? ownPost : null;
          const winner = match.winning_alliance;
          const ownPreRecord = record.statbotics?.pre_epas?.[String(row.teamNumber)];
          const ownPostRecord = record.statbotics?.epas?.[String(row.teamNumber)];
          const numericComponents = (value: object | null | undefined): Record<string, number> => {
            if (!value) return {};
            return Object.fromEntries(Object.entries(value).filter(([key, amount]) =>
              typeof amount === "number" && Number.isFinite(amount) && !/^comp_\\d+_epa$/.test(key),
            )) as Record<string, number>;
          };
          const allianceTeamKeys = match.alliances[alliance].team_keys;
          const opponentTeamKeys = match.alliances[opponentAlliance].team_keys;
          const sumPreEPA = (teamKeys: string[]) => {
            const values = teamKeys.map((key) => {
              const value = record.statbotics?.pre_epas?.[String(Number(key.replace(/^frc/i, "")))]?.epa;
              return typeof value === "number" && Number.isFinite(value) ? value : null;
            });
            return values.every((value) => value !== null)
              ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
          };
          const alliancePreComponents: Record<string, number> = {};
          for (const key of ["auto_epa", "teleop_epa", "endgame_epa", "rp_1_epa", "rp_2_epa", "rp_3_epa", "tiebreaker_epa"]) {
            const values = allianceTeamKeys.map((teamKey) => {
              const value = record.statbotics?.pre_epas?.[String(Number(teamKey.replace(/^frc/i, "")))];
              const amount = value?.[key as keyof typeof value];
              return typeof amount === "number" && Number.isFinite(amount) ? amount : null;
            });
            if (values.every((value) => value !== null)) alliancePreComponents[key] = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
          }
          const scoreBreakdown = match.score_breakdown as unknown as Record<string, Record<string, unknown>> | null;
          const actualAllianceBreakdown = scoreBreakdown?.[alliance] ?? {};
          const actualComponents: Record<string, number> = {};
          const autoField = Object.keys(actualAllianceBreakdown).find((field) => /^(total)?auto(points)?$/i.test(field.replace(/[_\\s-]/g, "")) && typeof actualAllianceBreakdown[field] === "number");
          const teleopField = Object.keys(actualAllianceBreakdown).find((field) => /^(total)?teleop(points)?$/i.test(field.replace(/[_\\s-]/g, "")) && typeof actualAllianceBreakdown[field] === "number");
          const foulField = Object.keys(actualAllianceBreakdown).find((field) => /^foul(points)?$/i.test(field.replace(/[_\\s-]/g, "")) && typeof actualAllianceBreakdown[field] === "number");
          if (autoField) actualComponents.auto = actualAllianceBreakdown[autoField] as number;
          if (teleopField) actualComponents.teleop = actualAllianceBreakdown[teleopField] as number;
          if (foulField) actualComponents.fouls = actualAllianceBreakdown[foulField] as number;
          const allianceDeltas = allianceTeamKeys.map((key) => {
            const id = String(Number(key.replace(/^frc/i, "")));
            const before = record.statbotics?.pre_epas?.[id]?.epa;
            const after = record.statbotics?.epas?.[id]?.epa;
            return typeof before === "number" && Number.isFinite(before) && typeof after === "number" && Number.isFinite(after)
              ? after - before : null;
          }).filter((value): value is number => value !== null);
          const allianceDeltaSpread = allianceDeltas.length === allianceTeamKeys.length && allianceDeltas.length > 1
            ? Math.max(...allianceDeltas) - Math.min(...allianceDeltas) : null;
          return [{
            match_key: match.key, match_label: own?.matchLabel ?? match.key,
            competition_level: match.comp_level, alliance,
            partner_team_numbers: match.alliances[alliance].team_keys.filter((key) => key !== teamState.team_key)
              .map((key) => Number(key.replace(/^frc/i, ""))).filter(Number.isFinite),
            opponent_team_numbers: match.alliances[opponentAlliance].team_keys
              .map((key) => Number(key.replace(/^frc/i, ""))).filter(Number.isFinite),
            predicted_score: own?.predicted ?? null, actual_score: own?.actual ?? null,
            score_residual: own?.residual ?? null,
            opponent_predicted_score: opponent?.predicted ?? null,
            opponent_actual_score: opponent?.actual ?? null,
            opponent_score_residual: opponent?.residual ?? null,
            win_probability: winProbability,
            won: winner === "red" || winner === "blue" ? winner === alliance : null,
            pre_match_epa: preEpa, post_match_epa: postEpa,
            epa_change: preEpa !== null && postEpa !== null ? postEpa - preEpa : null,
            alliance_pre_epa_total: sumPreEPA(allianceTeamKeys),
            opponent_pre_epa_total: sumPreEPA(opponentTeamKeys),
            alliance_pre_components: alliancePreComponents,
            actual_components: actualComponents,
            pre_match_components: numericComponents(ownPreRecord),
            post_match_components: numericComponents(ownPostRecord),
            alliance_delta_spread: allianceDeltaSpread,
            shared_alliance_update: allianceDeltaSpread !== null && allianceDeltaSpread < 0.000001,
          }];
        });
        const teamFindings = (insight?.reviewMatches ?? [])
          .filter((item) => item.reasons.length > 0)
          .map((item) => teamFinding(teamState.team_key, item));
        const analytics: FieldViewTeamEventAnalytics = {
          team_key: teamState.team_key,
          event_key: teamState.event_key,
          metrics,
          findings: teamFindings,
          ...(insight ? {
            summary: insight.summary,
            performance: {
              rank: insight.metrics.rank, wins: insight.metrics.wins, losses: insight.metrics.losses,
              ties: insight.metrics.ties, matches_seen: insight.metrics.matchesSeen,
              completed_matches: insight.metrics.completedMatches, epa: insight.metrics.epa,
              epa_percentile: insight.metrics.epaPercentile, auto_epa: insight.metrics.autoEpa,
              teleop_epa: insight.metrics.teleopEpa, endgame_epa: insight.metrics.endgameEpa,
              epa_start: insight.metrics.epaStart, epa_end: insight.metrics.epaEnd, epa_change: insight.metrics.epaChange,
            },
            epa_trend: insight.epaTrend.map((point) => ({ match_key: point.matchKey, match_label: point.matchLabel, epa: point.epa })),
            peer_performance: {
              team_match_count: insight.peerPerformance.teamMatches,
              peer_alliance_count: insight.peerPerformance.peerAllianceCount,
              team_mean_residual: insight.peerPerformance.teamMeanResidual,
              peer_mean_residual: insight.peerPerformance.peerMeanResidual,
              difference: insight.peerPerformance.difference,
              interpretation: insight.peerPerformance.interpretation,
            },
            match_evidence: matchEvidence,
            review_matches: insight.reviewMatches.map((item) => ({
              match_key: item.matchKey, match_label: item.matchLabel, alliance: item.alliance,
              partner_team_numbers: item.partners, opponent_team_numbers: item.opponents,
              predicted_score: item.predicted, actual_score: item.actual, score_residual: item.residual,
              win_probability: item.winProbability, won: item.won, pre_match_epa: item.preEPA,
              post_match_epa: item.postEPA, epa_change: item.deltaEPA, reasons: item.reasons,
            })),
            season_comparison: insight.seasonComparison ? {
              prior_event: {
                event_key: insight.seasonComparison.priorEvent.key,
                event_name: insight.seasonComparison.priorEvent.name,
                short_name: insight.seasonComparison.priorEvent.short_name,
                start_date: insight.seasonComparison.priorEvent.startDate,
              },
              prior_epa: insight.seasonComparison.priorEPA,
              current_epa: insight.seasonComparison.currentEPA,
              current_epa_percentile: insight.seasonComparison.currentEpaPercentile,
              prior_epa_rank: insight.seasonComparison.priorEpaRank,
              prior_epa_comparison_size: insight.seasonComparison.priorEpaCohortSize,
              current_epa_rank: insight.seasonComparison.currentEpaRank,
              current_epa_comparison_size: insight.seasonComparison.currentEpaCohortSize,
              change: insight.seasonComparison.change,
              comparison_rank: insight.seasonComparison.cohortRank,
              comparison_size: insight.seasonComparison.cohortSize,
              components: {
                auto: insight.seasonComparison.components.auto ? {
                  prior: insight.seasonComparison.components.auto.prior,
                  current: insight.seasonComparison.components.auto.current,
                  change: insight.seasonComparison.components.auto.change,
                  comparison_rank: insight.seasonComparison.components.auto.cohortRank,
                  comparison_size: insight.seasonComparison.components.auto.cohortSize,
                } : null,
                teleop: insight.seasonComparison.components.teleop ? {
                  prior: insight.seasonComparison.components.teleop.prior,
                  current: insight.seasonComparison.components.teleop.current,
                  change: insight.seasonComparison.components.teleop.change,
                  comparison_rank: insight.seasonComparison.components.teleop.cohortRank,
                  comparison_size: insight.seasonComparison.components.teleop.cohortSize,
                } : null,
                endgame: insight.seasonComparison.components.endgame ? {
                  prior: insight.seasonComparison.components.endgame.prior,
                  current: insight.seasonComparison.components.endgame.current,
                  change: insight.seasonComparison.components.endgame.change,
                  comparison_rank: insight.seasonComparison.components.endgame.cohortRank,
                  comparison_size: insight.seasonComparison.components.endgame.cohortSize,
                } : null,
              },
            } satisfies FieldViewTeamSeasonComparison : null,
            season_history: insight.seasonHistory.map((item) => ({
              event: {
                event_key: item.event.key, event_name: item.event.name,
                start_date: item.event.startDate,
              },
              epa_total: item.epaTotal, match_count: item.matches, status: item.status,
            })),
          } : {}),
          audit,
        };
        return { ...teamState, analytics };
      });
  return team_states;
}

import type { FieldViewEventState } from "../../domain/src/event.ts";
import type { FieldViewTeamEventState } from "../../domain/src/team.ts";
import type {
  FieldViewAnalyticsAudit,
  FieldViewAnalyticsEvidence,
  FieldViewAnalyticsFinding,
  FieldViewAnalyticsPopulation,
  FieldViewMetricResult,
  FieldViewTeamEventAnalytics,
  FieldViewTeamMatchEvidence,
  FieldViewAnalyticsAllianceResult,
  FieldViewAnalyticsTeamSummary,
  FieldViewQualificationAnalytics,
  FieldViewQualificationAnomaly,
  FieldViewPlayoffAnalytics,
  FieldViewEventTeamSeasonComparisonInput,
  FieldViewTeamSeasonComparison,
} from "../../domain/src/analytics.ts";
import type { AnalyticsMatch, AllianceResult } from "./types.ts";
import {
  buildReviewFindings,
  buildTeamInsights,
  buildTeamRows,
  buildQualificationAnalysis,
  buildQualificationAnomalies,
  buildPlayoffAnalysis,
  buildSeasonAwareTeamInsights,
  mean,
  standardDeviation,
} from "./calculations.ts";
import { getAnalyticsDefinition } from "./definitions.ts";

function population(key: string, totalCount: number, eligibleCount: number): FieldViewAnalyticsPopulation {
  const total = Math.max(0, totalCount);
  const eligible = Math.max(0, Math.min(total, eligibleCount));
  return {
    population_key: key,
    total_count: total,
    eligible_count: eligible,
    excluded_count: total - eligible,
  };
}

function metric(
  metricKey: string,
  definitionKey: string,
  value: number | null,
  unit: string,
  sampleSize: number,
  sourcePopulation: FieldViewAnalyticsPopulation,
  limitations: string[],
  comparison?: {
    population: FieldViewAnalyticsPopulation;
    rank_position: number | null;
    percentile: number | null;
  },
): FieldViewMetricResult {
  const definition = getAnalyticsDefinition(definitionKey);
  if (!definition) throw new Error("Missing analytics definition: " + definitionKey);
  const base = {
    metric_key: metricKey,
    definition_version: definition.version,
    unit,
    sample_size: Math.max(0, sampleSize),
    population: sourcePopulation,
    limitations,
    ...(comparison ? { comparison } : {}),
  };
  return typeof value === "number" && Number.isFinite(value)
    ? { ...base, status: "available", value }
    : { ...base, status: "insufficient-data", value: null };
}

function reviewFinding(
  finding: ReturnType<typeof buildReviewFindings>[number],
): FieldViewAnalyticsFinding {
  const sourcePopulation = population(
    finding.category === "alliance-pattern"
      ? "repeated-qualification-alliance-combinations"
      : "event-alliance-score-residuals",
    finding.sampleSize,
    finding.sampleSize,
  );
  const evidence: FieldViewAnalyticsEvidence[] = finding.evidence.map((label, index) => ({
    evidence_key: finding.id + ":evidence:" + String(index + 1),
    label,
    value: null,
    unit: "description",
    sample_size: finding.sampleSize,
    population: sourcePopulation,
  }));
  return {
    finding_key: finding.id,
    category: finding.category,
    scope: "alliance",
    subject_key: finding.subject,
    severity: finding.severity,
    title: finding.title,
    summary: finding.description,
    evidence,
    suggested_action: finding.suggestedAction,
    limitations: ["Alliance-level observation; this finding does not attribute performance to an individual robot."],
  };
}

function teamFinding(
  teamKey: string,
  item: ReturnType<typeof buildTeamInsights>[number]["reviewMatches"][number],
): FieldViewAnalyticsFinding {
  const evidence: FieldViewAnalyticsEvidence[] = [];
  if (item.residual !== null) {
    evidence.push({
      evidence_key: teamKey + ":" + item.matchKey + ":residual",
      label: "Alliance score residual",
      value: item.residual,
      unit: "points",
    });
  }
  if (item.winProbability !== null) {
    evidence.push({
      evidence_key: teamKey + ":" + item.matchKey + ":win-probability",
      label: "Team alliance win probability",
      value: item.winProbability,
      unit: "probability",
    });
  }
  if (item.deltaEPA !== null) {
    evidence.push({
      evidence_key: teamKey + ":" + item.matchKey + ":epa-change",
      label: "Model EPA update during this match",
      value: item.deltaEPA,
      unit: "EPA",
    });
  }
  return {
    finding_key: "team-match-review:" + teamKey + ":" + item.matchKey,
    category: "match-review",
    scope: "team",
    subject_key: teamKey,
    severity: "low",
    title: "Match review prompt",
    summary: item.reasons.join("; "),
    evidence,
    suggested_action: "Review the match and webcast alongside partner and opponent context.",
    limitations: ["The evidence is alliance-level or model-derived and does not establish individual robot causation."],
  };
}

/**
 * Calculate event-wide analytics. The optional compatibility path can attach
 * team analytics, while TeamRuntime calls calculateCanonicalTeamEventStates
 * directly and never executes this event-wide aggregate.
 */
export function calculateCanonicalAggregateAnalytics(
  eventState: FieldViewEventState,
  records: AnalyticsMatch[],
  allianceResults: AllianceResult[],
  audit: FieldViewAnalyticsAudit,
): FieldViewEventState {
  const teams = (eventState.teams ?? []).map((team) => ({
    key: team.key,
    team_number: team.team_number,
    nickname: team.nickname,
    name: team.name,
  }));
  const eventTeams = eventState.event_teams ?? [];
  const oprValues: Record<string, number> = {};
  const dprValues: Record<string, number> = {};
  const ccwmValues: Record<string, number> = {};
  for (const team of eventTeams) {
    if (team.opr !== undefined) oprValues[team.team_key] = team.opr;
    if (team.dpr !== undefined) dprValues[team.team_key] = team.dpr;
    if (team.ccwm !== undefined) ccwmValues[team.team_key] = team.ccwm;
  }
  const oprs = { oprs: oprValues, dprs: dprValues, ccwms: ccwmValues };
  const teamRows = buildTeamRows(teams, oprs, records);
  const findings = buildReviewFindings(records, allianceResults, teamRows, eventState.matches ?? []);
  const qualificationAnalysis = buildQualificationAnalysis(
    records, records.map((record) => record.match), allianceResults, eventState.event?.playoff_type,
  );
  const qualificationAnomalies = buildQualificationAnomalies(records, allianceResults, eventState.event?.playoff_type);
  const playoffAnalysis = buildPlayoffAnalysis(allianceResults, eventState.playoff_alliances ?? null);
  const residuals = allianceResults.flatMap((item) => item.residual === null ? [] : [item.residual]);
  const residualPopulation = population("event-alliance-sides", allianceResults.length, residuals.length);
  const winChecks = records.flatMap((record) => {
    const probability = record.statbotics?.pred?.red_win_prob;
    const winner = record.match.winning_alliance;
    if (typeof probability !== "number" || (winner !== "red" && winner !== "blue")) return [];
    return [(probability >= 0.5 ? "red" : "blue") === winner ? 1 : 0];
  });

  const eventMetrics: FieldViewMetricResult[] = [
    metric("mean-score-residual", "alliance-score-residual", mean(residuals), "points", residuals.length, residualPopulation, ["Positive values mean actual alliance scores exceeded Statbotics predictions."]),
    metric("score-residual-standard-deviation", "alliance-score-residual", standardDeviation(residuals), "points", residuals.length, residualPopulation, ["Uses the existing population-standard-deviation helper."]),
    metric("score-mean-absolute-error", "alliance-score-residual", residuals.length ? residuals.reduce((sum, value) => sum + Math.abs(value), 0) / residuals.length : null, "points", residuals.length, residualPopulation, ["Alliance-level prediction error; not individual robot attribution."]),
    metric("score-root-mean-square-error", "alliance-score-residual", residuals.length ? Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length) : null, "points", residuals.length, residualPopulation, ["Weights larger alliance score misses more heavily."]),
    metric("winner-prediction-accuracy", "qualification-prediction-calibration", winChecks.length ? winChecks.reduce((sum, value) => sum + value, 0) / winChecks.length : null, "ratio", winChecks.length, population("event-matches-with-prediction-and-known-winner", records.length, winChecks.length), ["Retains the existing >= 0.5 red-favorite tie convention used by the legacy event prediction summary."]),
  ];

  const allianceResultsDomain: FieldViewAnalyticsAllianceResult[] = allianceResults.map((item) => ({
    match_key: item.matchKey, match_label: item.matchLabel, competition_level: item.compLevel,
    alliance: item.color, team_keys: item.teamKeys, predicted_score: item.predicted,
    actual_score: item.actual, score_residual: item.residual, pre_match_epa_total: item.preEpaTotal,
    winner: item.winner, outcome: item.outcome,
  }));
  const teamSummaries: FieldViewAnalyticsTeamSummary[] = teamRows.map((item) => ({
    team_key: item.teamKey, team_number: item.teamNumber, name: item.name,
    opr: item.opr, dpr: item.dpr, ccwm: item.ccwm, epa: item.epa,
    auto_epa: item.autoEpa, teleop_epa: item.teleopEpa, endgame_epa: item.endgameEpa,
    matches_seen: item.matchesSeen, epa_percentile: item.epaPercentile,
    epa_contribution_percent: item.epaContributionPercent, epa_contribution_samples: item.epaContributionSamples,
  }));
  const qualificationDomain: FieldViewQualificationAnalytics = {
    prediction_calibration: {
      match_count: qualificationAnalysis.predictionCalibration.matchCount,
      correct_count: qualificationAnalysis.predictionCalibration.correctCount,
      underdog_wins: qualificationAnalysis.predictionCalibration.underdogWins,
      accuracy: qualificationAnalysis.predictionCalibration.accuracy,
      brier_score: qualificationAnalysis.predictionCalibration.brierScore,
      high_confidence_misses: qualificationAnalysis.predictionCalibration.highConfidenceMisses.map((item) => ({
        match_key: item.matchKey, match_label: item.matchLabel, predicted_winner: item.predictedWinner, probability: item.probability,
      })),
      bins: qualificationAnalysis.predictionCalibration.bins.map((item) => ({
        label: item.label, count: item.count, mean_predicted: item.meanPredicted,
        observed_red_win_rate: item.observedRedWinRate, calibration_error: item.calibrationError,
      })),
    },
    score_prediction: {
      alliance_count: qualificationAnalysis.scorePrediction.allianceCount,
      mean_absolute_error: qualificationAnalysis.scorePrediction.meanAbsoluteError,
      root_mean_square_error: qualificationAnalysis.scorePrediction.rootMeanSquareError,
      mean_residual: qualificationAnalysis.scorePrediction.meanResidual,
      within_25_count: allianceResults.filter((item) => item.compLevel.toLowerCase() === "qm" && item.residual !== null && Math.abs(item.residual) <= 25).length,
      win_prediction_count: qualificationAnalysis.predictionCalibration.matchCount,
      win_prediction_accuracy: qualificationAnalysis.predictionCalibration.accuracy,
    },
    progression: qualificationAnalysis.progression.map((item) => ({
      label: item.label, first_match: item.firstMatch, last_match: item.lastMatch,
      alliance_count: item.allianceCount, mean_absolute_error: item.meanAbsoluteError, mean_residual: item.meanResidual,
    })),
    penalties: {
      sample_size: qualificationAnalysis.penalties.sampleSize,
      matches_with_penalty_points: qualificationAnalysis.penalties.matchesWithPenaltyPoints,
      total_penalty_points: qualificationAnalysis.penalties.totalPenaltyPoints,
      mean_penalty_points: qualificationAnalysis.penalties.meanPenaltyPoints,
      median_penalty_points: qualificationAnalysis.penalties.medianPenaltyPoints,
      outlier_threshold: qualificationAnalysis.penalties.outlierThreshold,
      flagged_matches: qualificationAnalysis.penalties.flaggedMatches.map((item) => ({
        match_key: item.matchKey, match_label: item.matchLabel, match_number: item.matchNumber,
        red_penalty_count: item.redPenaltyCount, blue_penalty_count: item.bluePenaltyCount,
        red_penalty_points: item.redPenaltyPoints, blue_penalty_points: item.bluePenaltyPoints,
        total_penalty_points: item.totalPenaltyPoints, red_flagged: item.redFlagged, blue_flagged: item.blueFlagged,
      })),
    },
  };
  const qualificationAnomaliesDomain: FieldViewQualificationAnomaly[] = qualificationAnomalies.map((item) => ({
    anomaly_key: item.id, match_key: item.matchKey, match_label: item.matchLabel, alliance: item.alliance,
    team_keys: item.teamKeys, predicted_score: item.predicted, actual_score: item.actual, score_residual: item.residual,
    margin_of_error: item.marginOfError, standardized_residual: item.standardizedResidual, win_probability: item.winProbability,
    outside_expected_range: item.outsideExpectedRange, high_confidence_miss: item.highConfidenceMiss,
    severity: item.severity, reasons: item.reasons,
  }));
  const playoffsDomain: FieldViewPlayoffAnalytics = {
    match_count: playoffAnalysis.matchCount, alliance_count: playoffAnalysis.allianceCount,
    alliances: playoffAnalysis.alliances.map((item) => ({
      name: item.name, team_keys: item.teamKeys, match_count: item.matchCount, scored_match_count: item.scoredMatchCount,
      wins: item.wins, losses: item.losses, ties: item.ties, unknown_outcomes: item.unknownOutcomes,
      mean_predicted_score: item.meanPredicted, mean_actual_score: item.meanActual,
      mean_score_residual: item.meanResidual, residual_standard_deviation: item.residualStandardDeviation,
      matches: item.matches.map((match) => ({
        match_key: match.matchKey, competition_level: match.compLevel, alliance: match.color, outcome: match.outcome,
        score_residual: match.residual, actual_score: match.actual, predicted_score: match.predicted,
      })),
    })),
  };
  return {
    ...eventState,
    analytics: {
      event_key: eventState.event_key,
      metrics: eventMetrics,
      findings: findings.map(reviewFinding),
      alliance_results: allianceResultsDomain,
      team_summaries: teamSummaries,
      qualification: qualificationDomain,
      qualification_anomalies: qualificationAnomaliesDomain,
      playoffs: playoffsDomain,
      residual_summary: {
        mean: mean(residuals), standard_deviation: standardDeviation(residuals), sample_size: residuals.length,
      },
      prediction_summary: qualificationDomain.score_prediction,
      collection: {
        state: records.some((record) => record.statboticsStatus === "unavailable") ? "partial" : "complete",
        processed_match_count: records.length,
        total_match_count: eventState.matches?.length ?? records.length,
        unavailable_match_count: records.filter((record) => record.statboticsStatus === "unavailable").length,
        updated_at: audit.calculated_at,
      },
      audit,
    },
  };
}
