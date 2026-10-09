"use client";

import type { TBAMatch } from "@/lib/tba/types";
import StatboticsMatchPredictionBar from "./StatboticsMatchPredictionBar";
import StatboticsMatchPredictionMetrics from "./StatboticsMatchPredictionMetrics";
import { useStatboticsMatch } from "@/lib/statbotics/useStatboticsMatch";

type JsonRecord = Record<string, unknown>;

export default function StatboticsPredictionStrip({
  match,
}: {
  match: TBAMatch | null;
}) {
  const resultPosted = Boolean(
    match &&
    typeof match.alliances.red.score === "number" &&
    match.alliances.red.score >= 0 &&
    typeof match.alliances.blue.score === "number" &&
    match.alliances.blue.score >= 0
  );
  const resultSignature = match
    ? `${resultPosted ? "final" : "pending"}:${match.alliances.red.score}:${match.alliances.blue.score}:${match.actual_time ?? ""}`
    : null;
  const { data, status } = useStatboticsMatch(match?.key, resultSignature);
  const prediction: JsonRecord = data?.pred && typeof data.pred === "object"
    ? data.pred
    : data?.prediction && typeof data.prediction === "object"
      ? data.prediction
      : {};

  if (!match) {
    return (
      <div className="flex h-[52px] items-center border-l border-t border-white/10 bg-neutral-950/95 px-3 text-xs text-neutral-500">
        No match available for Statbotics prediction.
      </div>
    );
  }

  return (
    <div className="flex h-[52px] min-w-0 flex-col overflow-hidden border-t border-white/10 bg-neutral-950/95">
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden px-1">
        <StatboticsMatchPredictionMetrics prediction={prediction} compact={true} />
      </div>
      <div className="h-1 w-full shrink-0">
        <StatboticsMatchPredictionBar prediction={prediction} status={status} compact={true} />
      </div>
    </div>
  );
}
