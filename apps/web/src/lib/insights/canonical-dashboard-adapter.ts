import type {
  FieldViewEventSnapshot,
  FieldViewEventAnalytics,
  FieldViewTeamAnalytics,
  FieldViewMatch,
} from "@fieldview/domain";
import type { CanonicalAnalyticsPublication } from "@/lib/events/workerRealtime";
import type {
  EventAnalyticsResponse,
  TeamInsight,
  TeamInsightMatch,
  TeamSeasonComparison,
} from "./types";
import type { StatboticsMatch } from "@/lib/statbotics/types";

function teamInsight(teamNumber: number, analytics: FieldViewTeamAnalytics): TeamInsight {
  const performance = analytics.performance;
  const comparison = analytics.season_comparison;
  const seasonComparison: TeamSeasonComparison | null = comparison ? {
    priorEvent: {
      key: comparison.prior_event.event_key,
      name: comparison.prior_event.event_name,
      short_name: comparison.prior_event.short_name,
      startDate: comparison.prior_event.start_date,
    },
    priorEPA: comparison.prior_epa,
    currentEPA: comparison.current_epa,
    currentEpaPercentile: comparison.current_epa_percentile,
    priorEpaRank: comparison.prior_epa_rank,
    priorEpaComparisonSize: comparison.prior_epa_comparison_size,
    currentEpaRank: comparison.current_epa_rank,
    currentEpaComparisonSize: comparison.current_epa_comparison_size,
    change: comparison.change,
    comparisonRank: comparison.comparison_rank,
    comparisonSize: comparison.comparison_size,
    components: {
      auto: comparison.components.auto ? {
        prior: comparison.components.auto.prior,
        current: comparison.components.auto.current,
        change: comparison.components.auto.change,
        comparisonRank: comparison.components.auto.comparison_rank,
        comparisonSize: comparison.components.auto.comparison_size,
      } : null,
      teleop: comparison.components.teleop ? {
        prior: comparison.components.teleop.prior,
        current: comparison.components.teleop.current,
        change: comparison.components.teleop.change,
        comparisonRank: comparison.components.teleop.comparison_rank,
        comparisonSize: comparison.components.teleop.comparison_size,
      } : null,
      endgame: comparison.components.endgame ? {
        prior: comparison.components.endgame.prior,
        current: comparison.components.endgame.current,
        change: comparison.components.endgame.change,
        comparisonRank: comparison.components.endgame.comparison_rank,
        comparisonSize: comparison.components.endgame.comparison_size,
      } : null,
    },
  } : null;
  const reviewMatches: TeamInsightMatch[] = (analytics.review_matches ?? []).map((item) => ({
    matchKey: item.match_key,
    matchLabel: item.match_label,
    alliance: item.alliance,
    partners: item.partner_team_numbers,
    opponents: item.opponent_team_numbers,
    predicted: item.predicted_score,
    actual: item.actual_score,
    residual: item.score_residual,
    winProbability: item.win_probability,
    won: item.won,
    preEPA: item.pre_match_epa,
    postEPA: item.post_match_epa,
    deltaEPA: item.epa_change,
    reasons: item.reasons,
  }));
  const peer = analytics.peer_performance;
  return {
    teamNumber,
    summary: analytics.summary ?? [],
    metrics: {
      rank: performance?.rank ?? null,
      wins: performance?.wins ?? null,
      losses: performance?.losses ?? null,
      ties: performance?.ties ?? null,
      matchesSeen: performance?.matches_seen ?? 0,
      completedMatches: performance?.completed_matches ?? 0,
      epa: performance?.epa ?? null,
      epaPercentile: performance?.epa_percentile ?? null,
      autoEpa: performance?.auto_epa ?? null,
      teleopEpa: performance?.teleop_epa ?? null,
      endgameEpa: performance?.endgame_epa ?? null,
      epaStart: performance?.epa_start ?? null,
      epaEnd: performance?.epa_end ?? null,
      epaChange: performance?.epa_change ?? null,
    },
    epaTrend: (analytics.epa_trend ?? []).map((item) => ({
      matchKey: item.match_key, matchLabel: item.match_label, epa: item.epa,
    })),
    seasonComparison,
    peerPerformance: {
      teamMatches: peer?.team_match_count ?? 0,
      peerAllianceCount: peer?.peer_alliance_count ?? 0,
      teamMeanResidual: peer?.team_mean_residual ?? null,
      peerMeanResidual: peer?.peer_mean_residual ?? null,
      difference: peer?.difference ?? null,
      interpretation: peer?.interpretation ?? "insufficient-sample",
    },
    seasonHistory: (analytics.season_history ?? []).map((item) => ({
      event: {
        key: item.event.event_key,
        name: item.event.event_name,
        startDate: item.event.start_date,
      },
      epaTotal: item.epa_total,
      matches: item.match_count,
      status: item.status,
    })),
    reviewMatches,
  };
}

function mapTeamAnalytics(snapshot: FieldViewEventSnapshot, publication: NonNullable<CanonicalAnalyticsPublication["publication"]>): TeamInsight[] {
  const teamNumbers = new Map((snapshot.teams ?? []).map((team) => [team.key, team.team_number]));
  return publication.teamAnalytics.flatMap((item) => {
    const teamNumber = teamNumbers.get(item.team_key);
    return typeof teamNumber === "number" && item.analytics
      ? [teamInsight(teamNumber, item.analytics)]
      : [];
  });
}

function mapMatch(match: FieldViewMatch, publicationMatch?: NonNullable<CanonicalAnalyticsPublication["publication"]>["matches"][number]) {
  // Prefer the publication's latest analysis, but retain the analysis already
  // attached to the canonical match snapshot when publication enrichment is absent.
  const analysis = publicationMatch?.analysis ?? match.analysis;
  const enriched = {
    ...match,
    ...(analysis ? { analysis } : {}),
    ...(publicationMatch?.flags ? { flags: publicationMatch.flags } : {}),
  };
  const epaEntries = [...match.teams.red, ...match.teams.blue];
  const pre_epas = Object.fromEntries(epaEntries.flatMap((team) =>
    typeof team.team_number === "number" && team.pre_epa
      ? [[String(team.team_number), team.pre_epa]]
      : [],
  ));
  const epas = Object.fromEntries(epaEntries.flatMap((team) =>
    typeof team.team_number === "number" && team.epa
      ? [[String(team.team_number), team.epa]]
      : [],
  ));
  const canonicalPrediction = match.predictions.statbotics;
  const scoreAnalysis = analysis?.score;
  const prediction = canonicalPrediction || scoreAnalysis
    ? ({
        ...(canonicalPrediction ?? {}),
        red_score: canonicalPrediction?.red_score ?? scoreAnalysis?.red.predicted,
        blue_score: canonicalPrediction?.blue_score ?? scoreAnalysis?.blue.predicted,
      })
    : undefined;
  const statbotics = prediction || Object.keys(pre_epas).length || Object.keys(epas).length
    ? ({ pred: prediction, pre_epas, epas } as unknown as StatboticsMatch)
    : null;
  return {
    match: enriched,
    statbotics,
    flags: publicationMatch?.flags ?? match.flags,
    statboticsStatus: statbotics ? "ready" as const : "unavailable" as const,
  };
}

function findingSampleCoverage(evidence: FieldViewEventAnalytics["findings"][number]["evidence"]): "low" | "medium" | "high" {
  const populations = evidence.flatMap((item) =>
    item.population && item.population.total_count > 0
      ? [item.population]
      : [],
  );
  if (populations.length) {
    const total = populations.reduce((sum, item) => sum + item.total_count, 0);
    const eligible = populations.reduce((sum, item) => sum + item.eligible_count, 0);
    const ratio = total > 0 ? eligible / total : 0;
    return ratio >= 0.8 ? "high" : ratio >= 0.5 ? "medium" : "low";
  }
  const sampleSize = Math.max(0, ...evidence.map((item) => item.sample_size ?? 0));
  return sampleSize >= 20 ? "high" : sampleSize >= 8 ? "medium" : "low";
}

function mapEventAnalytics(analytics: FieldViewEventAnalytics, snapshot: FieldViewEventSnapshot, publication: NonNullable<CanonicalAnalyticsPublication["publication"]>): EventAnalyticsResponse {
  const matches = (snapshot.matches ?? []).map((match) =>
    mapMatch(match, publication.matches.find((item) => item.key === match.key)),
  );
  const qualification = analytics.qualification;
  const prediction = analytics.prediction_summary ?? qualification?.score_prediction;
  const cohort = analytics.season_cohort;
  // Older publications may not include collection counters. Reconcile them
  // against the match-level analysis that is actually being rendered.
  const publishedProcessedMatchCount = matches.filter(({ match }) =>
    match.analysis !== undefined || match.flags !== undefined,
  ).length;
  const processedMatchCount = Math.max(
    analytics.collection?.processed_match_count ?? 0,
    publishedProcessedMatchCount,
  );
  const totalMatchCount = snapshot.matches?.length ?? analytics.collection?.total_match_count ?? matches.length;
  const unavailableMatchCount = Math.max(
    analytics.collection?.unavailable_match_count ?? 0,
    matches.filter((item) => item.statboticsStatus === "unavailable").length,
  );
  return {
    event: snapshot.event!,
    rankings: snapshot.rankings ?? null,
    // The canonical TBA roster is the source of truth for event participation.
    // Analytics summaries are enrichment only: a missing Statbotics row must not
    // remove a team from the investigation selector.
    teams: snapshot.teams !== undefined && snapshot.teams !== null
      ? snapshot.teams.flatMap((team) => {
          if (typeof team.team_number !== "number") return [];
          const summary = analytics.team_summaries?.find((item) => item.team_key === team.key);
          const eventTeam = snapshot.event_teams?.find((item) => item.team_key === team.key);
          return [{
            teamKey: team.key,
            teamNumber: team.team_number,
            name: team.nickname || summary?.name || `Team ${team.team_number}`,
            opr: summary?.opr ?? eventTeam?.opr ?? null,
            dpr: summary?.dpr ?? eventTeam?.dpr ?? null,
            ccwm: summary?.ccwm ?? eventTeam?.ccwm ?? null,
            epa: summary?.epa ?? null,
            autoEpa: summary?.auto_epa ?? null,
            teleopEpa: summary?.teleop_epa ?? null,
            endgameEpa: summary?.endgame_epa ?? null,
            matchesSeen: summary?.matches_seen ?? 0,
            epaPercentile: summary?.epa_percentile ?? null,
            epaContributionPercent: summary?.epa_contribution_percent ?? null,
            epaContributionSamples: summary?.epa_contribution_samples ?? 0,
          }];
        })
      : (analytics.team_summaries ?? []).map((item) => ({
          teamKey: item.team_key,
          teamNumber: item.team_number,
          name: item.name,
          opr: item.opr,
          dpr: item.dpr,
          ccwm: item.ccwm,
          epa: item.epa,
          autoEpa: item.auto_epa,
          teleopEpa: item.teleop_epa,
          endgameEpa: item.endgame_epa,
          matchesSeen: item.matches_seen,
          epaPercentile: item.epa_percentile,
          epaContributionPercent: item.epa_contribution_percent,
          epaContributionSamples: item.epa_contribution_samples,
        })),
    teamColors: Object.fromEntries((snapshot.teams ?? []).flatMap((team) =>
      typeof team.team_number === "number" && team.frc_colors
        ? [[String(team.team_number), {
            primaryHex: team.frc_colors.primary_hex,
            secondaryHex: team.frc_colors.secondary_hex,
          }]]
        : [],
    )),
    matches,
    allianceResults: (analytics.alliance_results ?? []).map((item) => {
      const match = snapshot.matches?.find((candidate) => candidate.key === item.match_key);
      const publishedMatch = publication.matches.find((candidate) => candidate.key === item.match_key);
      const score = (publishedMatch?.analysis ?? match?.analysis)?.score?.[item.alliance];
      const alliance = match?.alliances[item.alliance];
      const actual = item.actual_score ?? score?.actual ?? (typeof alliance?.score === "number" && alliance.score >= 0 ? alliance.score : null);
      const predicted = item.predicted_score ?? score?.predicted ?? null;
      const residual = item.score_residual ?? score?.delta ?? (
        actual !== null && predicted !== null ? actual - predicted : null
      );
      return {
        matchKey: item.match_key,
        matchLabel: item.match_label,
        compLevel: item.competition_level,
        color: item.alliance,
        teamKeys: item.team_keys,
        predicted,
        actual,
        residual,
        preEpaTotal: item.pre_match_epa_total,
        winner: item.winner,
        outcome: item.outcome,
      };
    }),
    findings: analytics.findings.map((item) => ({
      id: item.finding_key,
      category: item.category,
      subject: item.subject_key ?? item.scope,
      title: item.title,
      description: item.summary,
      evidence: item.evidence.map((evidence) =>
        evidence.value === null ? evidence.label : evidence.label + ": " + evidence.value + " " + evidence.unit,
      ),
      sampleSize: Math.max(0, ...item.evidence.map((evidence) => evidence.sample_size ?? evidence.population?.eligible_count ?? 0)),
      sampleCoverage: findingSampleCoverage(item.evidence),
      suggestedAction: item.suggested_action,
      severity: item.severity,
    })),
    qualificationAnomalies: (analytics.qualification_anomalies ?? []).map((item) => ({
      id: item.anomaly_key,
      matchKey: item.match_key,
      matchLabel: item.match_label,
      alliance: item.alliance,
      teamKeys: item.team_keys,
      predicted: item.predicted_score,
      actual: item.actual_score,
      residual: item.score_residual,
      marginOfError: item.margin_of_error,
      standardizedResidual: item.standardized_residual,
      winProbability: item.win_probability,
      outsideExpectedRange: item.outside_expected_range,
      highConfidenceMiss: item.high_confidence_miss,
      severity: item.severity,
      reasons: item.reasons,
    })),
    qualificationAnalysis: qualification ? {
      predictionCalibration: {
        matchCount: qualification.prediction_calibration.match_count,
        correctCount: qualification.prediction_calibration.correct_count,
        underdogWins: qualification.prediction_calibration.underdog_wins,
        accuracy: qualification.prediction_calibration.accuracy,
        brierScore: qualification.prediction_calibration.brier_score,
        highConfidenceMisses: qualification.prediction_calibration.high_confidence_misses.map((item) => ({
          matchKey: item.match_key, matchLabel: item.match_label,
          predictedWinner: item.predicted_winner, probability: item.probability,
        })),
        bins: qualification.prediction_calibration.bins.map((item) => ({
          label: item.label, count: item.count, meanPredicted: item.mean_predicted,
          observedRedWinRate: item.observed_red_win_rate, calibrationError: item.calibration_error,
        })),
      },
      scorePrediction: {
        allianceCount: qualification.score_prediction.alliance_count,
        meanAbsoluteError: qualification.score_prediction.mean_absolute_error,
        rootMeanSquareError: qualification.score_prediction.root_mean_square_error,
        meanResidual: qualification.score_prediction.mean_residual,
      },
      progression: qualification.progression.map((item) => ({
        label: item.label, firstMatch: item.first_match, lastMatch: item.last_match,
        allianceCount: item.alliance_count, meanAbsoluteError: item.mean_absolute_error,
        meanResidual: item.mean_residual,
      })),
      penalties: {
        sampleSize: qualification.penalties.sample_size,
        matchesWithPenaltyPoints: qualification.penalties.matches_with_penalty_points,
        totalPenaltyPoints: qualification.penalties.total_penalty_points,
        meanPenaltyPoints: qualification.penalties.mean_penalty_points,
        medianPenaltyPoints: qualification.penalties.median_penalty_points,
        outlierThreshold: qualification.penalties.outlier_threshold,
        flaggedMatches: qualification.penalties.flagged_matches.map((item) => ({
          matchKey: item.match_key, matchLabel: item.match_label, matchNumber: item.match_number,
          redPenaltyCount: item.red_penalty_count, bluePenaltyCount: item.blue_penalty_count,
          redPenaltyPoints: item.red_penalty_points, bluePenaltyPoints: item.blue_penalty_points,
          totalPenaltyPoints: item.total_penalty_points, redFlagged: item.red_flagged,
          blueFlagged: item.blue_flagged,
        })),
      },
    } : undefined,
    playoffAnalysis: analytics.playoffs ? {
      matchCount: analytics.playoffs.match_count,
      allianceCount: analytics.playoffs.alliance_count,
      alliances: analytics.playoffs.alliances.map((item) => ({
        name: item.name, teamKeys: item.team_keys, matchCount: item.match_count,
        scoredMatchCount: item.scored_match_count, wins: item.wins, losses: item.losses,
        ties: item.ties, unknownOutcomes: item.unknown_outcomes,
        meanPredicted: item.mean_predicted_score, meanActual: item.mean_actual_score,
        meanResidual: item.mean_score_residual, residualStandardDeviation: item.residual_standard_deviation,
        matches: item.matches.map((match) => ({
          matchKey: match.match_key, compLevel: match.competition_level, color: match.alliance,
          outcome: match.outcome, residual: match.score_residual,
          actual: match.actual_score, predicted: match.predicted_score,
        })),
      })),
    } : undefined,
    teamInsights: mapTeamAnalytics(snapshot, publication),
    seasonCohort: cohort ? {
      state: cohort.state,
      teamCount: cohort.team_count,
      totalTeamEventRecords: cohort.total_team_event_records,
      processedTeamEventRecords: cohort.processed_team_event_records,
      unavailableTeamEventRecords: cohort.unavailable_team_event_records,
      discoveryPendingTeams: cohort.discovery_pending_teams,
      updatedAt: cohort.updated_at,
      records: cohort.records.map((item) => ({
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
    } : undefined,
    matchCount: snapshot.matches?.length ?? 0,
    loadedMatchCount: matches.length,
    offset: 0,
    limit: matches.length,
    hasMore: false,
    residualStats: {
      mean: analytics.residual_summary?.mean ?? null,
      standardDeviation: analytics.residual_summary?.standard_deviation ?? null,
      sampleSize: analytics.residual_summary?.sample_size ?? 0,
    },
    predictionStats: {
      allianceCount: prediction?.alliance_count ?? 0,
      meanAbsoluteError: prediction?.mean_absolute_error ?? null,
      rootMeanSquareError: prediction?.root_mean_square_error ?? null,
      meanResidual: prediction?.mean_residual ?? null,
      within25Count: prediction?.within_25_count ?? 0,
      winPredictionCount: prediction?.win_prediction_count ?? 0,
      winPredictionAccuracy: prediction?.win_prediction_accuracy ?? null,
    },
    collection: {
      state: processedMatchCount >= totalMatchCount
        ? unavailableMatchCount > 0 ? "partial" : "complete"
        : analytics.collection?.state ?? (processedMatchCount > 0 ? "partial" : "queued"),
      processedMatchCount,
      totalMatchCount,
      unavailableMatchCount,
      statboticsFetchError: analytics.collection?.statbotics_fetch_error ?? null,
      updatedAt: analytics.collection?.updated_at ?? publication.calculatedAt,
    },
  };
}

export function toEventAnalyticsDashboardData(
  snapshot: FieldViewEventSnapshot,
  publication: CanonicalAnalyticsPublication | undefined,
): EventAnalyticsResponse | null {
  if (!snapshot.event || !publication?.publication?.eventAnalytics) return null;
  return mapEventAnalytics(publication.publication.eventAnalytics, snapshot, publication.publication);
}
