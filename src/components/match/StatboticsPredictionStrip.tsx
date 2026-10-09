"use client";

import type { TBAMatch } from "@/lib/tba/types";
import MatchCard from "./MatchCard";
import StatboticsMatchPredictionBar from "./StatboticsMatchPredictionBar";
import StatboticsMatchPredictionMetrics from "./StatboticsMatchPredictionMetrics";
import { useStatboticsMatch } from "@/lib/statbotics/useStatboticsMatch";

export default function StatboticsPredictionStrip({
  match,
  team = [],
  playoffType = null,
  playoffAlliances = [],
  eventTimezone,
}: {
  match: TBAMatch | null;
  team?: string[];
  playoffType?: number | null;
  playoffAlliances?: Parameters<typeof MatchCard>[0]["playoffAlliances"];
  eventTimezone?: string | null;
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
  const prediction = data?.pred && typeof data.pred === "object"
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
    <div className="h-[52px] overflow-x-auto overflow-y-hidden no-scrollbar border-l border-t border-white/10 bg-neutral-950/95">
      <div className="flex min-w-max items-center gap-1.5 px-2 pb-0 mb-0">
        <StatboticsMatchPredictionBar prediction={prediction} status={status} compact={true} />
      </div>
      <div className="flex h-full min-w-max items-center gap-1.5 px-2">
        <MatchCard
          match={match}
          team={team}
          playoffType={playoffType}
          playoffAlliances={playoffAlliances}
          eventTimezone={eventTimezone ?? undefined}
          isNext={!resultPosted}
          isLast={resultPosted}
        />
        <StatboticsMatchPredictionMetrics prediction={prediction} compact={true} />
      </div>
    </div>
  );
}
