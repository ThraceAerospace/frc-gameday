"use client";

import type { TBAMatch } from "@/lib/tba/types";
import StatboticsMatchPredictionBar from "./StatboticsMatchPredictionBar";
import StatboticsMatchPredictionMetrics from "./StatboticsMatchPredictionMetrics";
import { useEventState } from "@/lib/events";
import { matchShortName } from "@/lib/tba/formatters";

type JsonRecord = Record<string, unknown>;

export default function StatboticsPredictionStrip({
  match,
}: {
  match: TBAMatch | null;
}) {
  const eventKey = match?.key.split("_")[0] ?? "";
  const eventState = useEventState(eventKey);
  const statboticsState = match ? eventState.statboticsMatches[match.key] : undefined;
  const data = statboticsState?.data ?? null;
  const status = statboticsState?.status ?? "loading";
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
        <div>
          <h5 className="text-xs font-semibold text-white pr-2">Statbotics Prediction</h5>
          <h5 className="text-xs font-medium text-white">{matchShortName(match)}</h5>
        </div>
        <StatboticsMatchPredictionMetrics prediction={prediction} compact={true} />
      </div>
      <div className="h-1 w-[95%] shrink-0 mx-auto">
        <StatboticsMatchPredictionBar prediction={prediction} status={status} compact={true} />
      </div>
    </div>
  );
}
