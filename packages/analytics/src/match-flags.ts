import type {
  FieldViewAllianceFlag,
  FieldViewMatchFlags,
  FieldViewMatchReviewFlag,
  FieldViewPredictionLabel,
} from "../../domain/src/match.ts";
import type { AnalyticsMatch, EventAnalyticsResponse } from "./types.ts";

function quantile(values: number[], probability: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1)];
}

function predictionClassification(redWinProbability: number | null): FieldViewPredictionLabel | null {
  if (redWinProbability === null || !Number.isFinite(redWinProbability)) return null;
  if (redWinProbability >= 0.8) return "Strong Red";
  if (redWinProbability >= 0.6) return "Lean Red";
  if (redWinProbability <= 0.2) return "Strong Blue";
  if (redWinProbability <= 0.4) return "Lean Blue";
  return "Toss-up";
}

function phaseAnomalyBand(
  data: Pick<EventAnalyticsResponse, "allianceResults">,
  compLevel: string,
): { median: number; margin: number } | null {
  const residuals = data.allianceResults
    .filter((item) => item.compLevel.toLowerCase() === compLevel.toLowerCase() && item.residual !== null)
    .map((item) => item.residual as number)
    .sort((a, b) => a - b);
  if (residuals.length < 8) return null;
  // Preserve the current dashboard's upper-middle convention for even samples.
  const median = residuals[Math.floor(residuals.length / 2)];
  const deviations = residuals.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)];
  return { median, margin: Math.max(20, 3 * 1.4826 * mad) };
}

/**
 * Backend equivalent of the existing EventAnalyticsDashboard match flag
 * calculation. Thresholds, quantile convention, and inclusivity are retained
 * exactly; this function intentionally does not reinterpret the math.
 */
export function buildMatchFlags(
  data: Pick<EventAnalyticsResponse, "allianceResults" | "qualificationAnalysis">,
  record: AnalyticsMatch,
): FieldViewMatchFlags {
  const { match, statbotics } = record;
  const redProbability = typeof statbotics?.pred?.red_win_prob === "number"
    ? statbotics.pred.red_win_prob
    : null;
  const prediction = predictionClassification(redProbability);
  const predictedWinner = redProbability === null || redProbability === 0.5
    ? null
    : redProbability > 0.5 ? "red" as const : "blue" as const;

  const redScore = match.alliances.red.score;
  const blueScore = match.alliances.blue.score;
  const completed = redScore >= 0 && blueScore >= 0;
  const winner = match.winning_alliance === "red" || match.winning_alliance === "blue"
    ? match.winning_alliance
    : completed && redScore !== blueScore
      ? redScore > blueScore ? "red" as const : "blue" as const
      : null;
  const favoriteProbability = redProbability === null ? null : Math.max(redProbability, 1 - redProbability);
  const modelUpset = completed && winner !== null && predictedWinner !== null &&
    winner !== predictedWinner && favoriteProbability !== null && favoriteProbability >= 0.6;

  const matchResults = data.allianceResults.filter((item) => item.matchKey === match.key);
  const allianceEpaValues = data.allianceResults.flatMap((item) =>
    item.preEpaTotal === null ? [] : [item.preEpaTotal],
  );
  const highEpaThreshold = allianceEpaValues.length >= 8
    ? quantile(allianceEpaValues, 0.75)
    : null;
  const highAllianceEpa = {
    red: highEpaThreshold !== null &&
      (matchResults.find((item) => item.color === "red")?.preEpaTotal ?? -Infinity) >= highEpaThreshold,
    blue: highEpaThreshold !== null &&
      (matchResults.find((item) => item.color === "blue")?.preEpaTotal ?? -Infinity) >= highEpaThreshold,
  };

  const anomalyBand = phaseAnomalyBand(data, match.comp_level);
  const anomalousScore = anomalyBand !== null && matchResults.some((item) =>
    item.residual !== null && Math.abs(item.residual - anomalyBand.median) > anomalyBand.margin,
  );
  const residualMagnitudes = data.allianceResults.flatMap((item) =>
    item.residual === null ? [] : [Math.abs(item.residual)],
  );
  const largeResidualThreshold = residualMagnitudes.length >= 20
    ? quantile(residualMagnitudes, 0.9)
    : null;
  const largeResidual = {
    red: largeResidualThreshold !== null &&
      matchResults.find((item) => item.color === "red")?.residual != null &&
      Math.abs(matchResults.find((item) => item.color === "red")!.residual!) >= largeResidualThreshold,
    blue: largeResidualThreshold !== null &&
      matchResults.find((item) => item.color === "blue")?.residual != null &&
      Math.abs(matchResults.find((item) => item.color === "blue")!.residual!) >= largeResidualThreshold,
  };

  const qualification = match.comp_level.toLowerCase() === "qm";
  const penaltyRow = qualification
    ? data.qualificationAnalysis?.penalties.flaggedMatches.find((item) => item.matchKey === match.key)
    : undefined;
  const highPenalties = { red: penaltyRow?.redFlagged ?? false, blue: penaltyRow?.blueFlagged ?? false };

  const reviewFlags: FieldViewMatchReviewFlag[] = [];
  if (modelUpset) reviewFlags.push("model-upset");
  if (anomalousScore) reviewFlags.push("anomalous-score");
  if (largeResidual.red || largeResidual.blue) reviewFlags.push("large-residual");
  if (highPenalties.red || highPenalties.blue) reviewFlags.push("high-penalties");
  if (highAllianceEpa.red || highAllianceEpa.blue) reviewFlags.push("high-alliance-epa");

  const allianceFlags = (color: "red" | "blue"): FieldViewAllianceFlag[] => {
    const result = matchResults.find((item) => item.color === color);
    const flags: FieldViewAllianceFlag[] = [];
    if (predictedWinner !== null && redProbability !== null) {
      flags.push({
        type: predictedWinner === color ? "predicted-win" : "predicted-loss",
        evidence: {
          prediction_source: "statbotics",
          predicted_winner: predictedWinner,
          red_win_probability: redProbability,
        },
      });
    }
    if (anomalyBand !== null && result?.residual !== null && result?.residual !== undefined &&
        Math.abs(result.residual - anomalyBand.median) > anomalyBand.margin &&
        result.actual !== null && result.predicted !== null) {
      flags.push({
        type: "anomalous-score",
        evidence: {
          actual_score: result.actual,
          predicted_score: result.predicted,
          residual: result.residual,
          phase_median: anomalyBand.median,
          phase_margin: anomalyBand.margin,
          sample_size: data.allianceResults.filter((item) =>
            item.compLevel.toLowerCase() === match.comp_level.toLowerCase() && item.residual !== null,
          ).length,
        },
      });
    }
    if (highEpaThreshold !== null && highAllianceEpa[color] && result?.preEpaTotal !== null && result?.preEpaTotal !== undefined) {
      flags.push({
        type: "high-alliance-epa",
        evidence: {
          pre_match_alliance_epa: result.preEpaTotal,
          event_threshold: highEpaThreshold,
          sample_size: allianceEpaValues.length,
        },
      });
    }
    if (largeResidualThreshold !== null && largeResidual[color] && result?.residual !== null && result?.residual !== undefined &&
        result.actual !== null && result.predicted !== null) {
      flags.push({
        type: "large-score-delta",
        evidence: {
          actual_score: result.actual,
          predicted_score: result.predicted,
          delta: result.residual,
          absolute_delta: Math.abs(result.residual),
          event_threshold: largeResidualThreshold,
          sample_size: residualMagnitudes.length,
        },
      });
    }
    if (penaltyRow && highPenalties[color]) {
      const points = color === "red" ? penaltyRow.redPenaltyPoints : penaltyRow.bluePenaltyPoints;
      flags.push({
        type: "high-penalties",
        evidence: {
          penalty_points: points,
          event_threshold: data.qualificationAnalysis?.penalties.outlierThreshold ?? points,
          sample_size: (data.qualificationAnalysis?.penalties.sampleSize ?? 0) * 2,
        },
      });
    }
    return flags;
  };

  return {
    prediction: prediction && redProbability !== null
      ? {
          label: prediction,
          prediction_source: "statbotics",
          predicted_winner: predictedWinner,
          red_win_probability: redProbability,
        }
      : null,
    winner,
    review_flags: reviewFlags,
    alliances: {
      red: allianceFlags("red"),
      blue: allianceFlags("blue"),
    },
  };
}
