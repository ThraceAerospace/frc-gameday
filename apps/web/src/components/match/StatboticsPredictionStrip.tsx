"use client";

import type { StatboticsPrediction } from "@/lib/statbotics/types";
import { useEventState } from "@/lib/events";
import { matchShortName } from "@/lib/tba/formatters";
import type { TBAMatch } from "@/lib/tba/types";
import StatboticsMatchPredictionBar from "./StatboticsMatchPredictionBar";
import StatboticsMatchPredictionMetrics from "./StatboticsMatchPredictionMetrics";

export default function StatboticsPredictionStrip({ match }: { match: TBAMatch | null }) {
  const eventKey = match?.key.split("_")[0] ?? "";
  const eventState = useEventState(eventKey);
  const statboticsState = match ? eventState.statboticsMatches[match.key] : undefined;
  const data = statboticsState?.data ?? null;
  const status = statboticsState?.status ?? "loading";
  const prediction: StatboticsPrediction | undefined = data?.pred ?? undefined;

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
