"use client";

import type {
  TBAMatch,
  TBAEliminationAlliance,
  TBATeamEventStatus,
} from "@/lib/tba/types";

import { compactMatchLabel } from "@/lib/gameday/matchUtils";
import NextMatchCountdown from "@/components/match/NextMatchCountdown";

function allianceLabel(
  team: string,
  alliances: TBAEliminationAlliance[],
) {
  const teamKey = String(team).toLowerCase();

  const alliance = alliances.find((entry) =>
    entry.picks.some(
      (pick) => String(pick).toLowerCase() === teamKey,
    ),
  );

  if (!alliance?.name) {
    return null;
  }

  return alliance.name.replace("Alliance ", "A");
}

function matchLabel(
  match: TBAMatch | null | undefined,
  playoffType: number | null,
) {
  if (!match) {
    return null;
  }

  if (playoffType === 10) {
    return match.match_number != null
      ? `M${match.match_number}`
      : null;
  }

  return compactMatchLabel(match);
}

export default function TeamPill({
  team,
  status,
  nextMatch,
  playoffAlliances = [],
  playoffType = null,
}: {
  team: string;
  status: TBATeamEventStatus | null | undefined;
  nextMatch: TBAMatch | null | undefined;
  playoffAlliances?: TBAEliminationAlliance[];
  playoffType?: number | null;
}) {
  const record = status?.qual?.ranking?.record;
  const teamNumber = String(team).replace(/^frc/i, "");

  const wins = record?.wins ?? 0;
  const losses = record?.losses ?? 0;
  const ties = record?.ties ?? 0;

  const recordLabel = record
    ? ties > 0
      ? `${wins}-${losses}-${ties}`
      : `${wins}-${losses}`
    : "—";

  const alliance = allianceLabel(
    team,
    playoffAlliances,
  );

  const rankLabel = alliance
    ? alliance
    : status?.qual?.ranking?.rank
      ? `#${status.qual.ranking.rank}`
      : "—";

  const nextMatchLabel = matchLabel(
    nextMatch,
    playoffType,
  );

  return (
    <div className="flex h-7 items-center gap-1.5 rounded-md border border-white/10 bg-neutral-950/90 px-2 shadow-lg backdrop-blur">
      <span className="font-mono text-[11px] font-bold">
        {teamNumber}
      </span>

      <span className="font-mono text-[11px] text-neutral-300">
        {recordLabel}
      </span>

      <span className="font-mono text-[11px] text-neutral-300">
        {rankLabel}
      </span>

      {nextMatchLabel && (
        <>
          <span className="h-3 w-px bg-white/10" />

          <span className="font-mono text-[10px] font-bold">
            {nextMatchLabel}
          </span>

          {nextMatch?.predicted_time != null && (
            <span className="font-mono text-[11px] text-neutral-400">
              <NextMatchCountdown nextMatch={nextMatch} />
            </span>
          )}
        </>
      )}
    </div>
  );
}
