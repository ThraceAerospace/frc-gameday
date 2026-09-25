"use client";

import type { TBAMatch, TBATeamEventStatus } from "@/lib/tba/types";

import { compactMatchLabel } from "@/lib/gameday/matchUtils";
import NextMatchCountdown from "@/components/gameday/match/NextMatchCountdown";

export default function TeamPill({
  team,
  status,
  teamCount,
  nextMatch,
}: { team: string; status: TBATeamEventStatus | null | undefined; teamCount: number; nextMatch: TBAMatch | null | undefined }) {

  const record = status?.qual?.ranking?.record;

  const teamNumber = String(team).replace(/^frc/i, "");

  const recordLabel = record
    ? `${record.wins ?? 0}-${record.losses ?? 0}-${record.ties ?? 0}`
    : "—";

  const rankingLabel = status?.qual?.ranking?.rank
    ? `#${status.qual.ranking.rank}/${teamCount || "?"}`
    : "—";

  return (
    <div className="flex h-7 items-center gap-1.5 rounded-md border border-white/10 bg-neutral-950/90 px-2 shadow-lg backdrop-blur">
      <span className="font-mono text-[11px] font-bold">
        {teamNumber}
      </span>

      <span className="font-mono text-[9px] text-neutral-400">
        {recordLabel}
      </span>

      <span className="font-mono text-[9px] text-neutral-500">
        {rankingLabel}
      </span>

      {nextMatch && (
        <>
          <span className="h-3 w-px bg-white/10" />

          <span className="font-mono text-[10px] font-bold">
            {compactMatchLabel(nextMatch)}
          </span>

          {nextMatch.predicted_time != null && (
            <span className="font-mono text-[9px] text-neutral-400">
              <NextMatchCountdown nextMatch={nextMatch} />
            </span>
          )}
        </>
      )}
    </div>
  );
}