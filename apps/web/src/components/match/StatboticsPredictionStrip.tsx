"use client";

import type { FieldViewMatch } from "@fieldview/domain";
import { matchShortName } from "@/lib/tba/formatters";
import StatboticsMatchPredictionBar from "./StatboticsMatchPredictionBar";
import StatboticsMatchPredictionMetrics from "./StatboticsMatchPredictionMetrics";

export default function StatboticsPredictionStrip({ match }: { match: FieldViewMatch | null }) {
  const sourceStatus = match?.sources.statbotics_match?.status;
  const status = sourceStatus === "available" || sourceStatus === "stale"
    ? "ready"
    : sourceStatus === "unavailable" || sourceStatus === "failed"
      ? "unavailable"
      : "loading";
  const prediction = match?.predictions.statbotics;

  if (!match) {
    return <div className="flex h-[52px] items-center border-l border-t border-white/10 bg-neutral-950/95 px-3 text-xs text-neutral-500">No match available for Statbotics prediction.</div>;
  }

  return (
    <div className="flex h-[52px] min-w-0 flex-col overflow-hidden border-t border-white/10 bg-neutral-950/95">
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden px-1">
        <div>
          <h5 className="pr-2 text-xs font-semibold text-white">Statbotics Prediction</h5>
          <h5 className="text-xs font-medium text-white">{matchShortName(match)}</h5>
        </div>
        <StatboticsMatchPredictionMetrics prediction={prediction} compact={true} />
      </div>
      <div className="mx-auto h-1 w-[95%] shrink-0">
        <StatboticsMatchPredictionBar prediction={prediction} status={status} compact={true} />
      </div>
    </div>
  );
}
