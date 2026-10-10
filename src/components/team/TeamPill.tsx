"use client";

import type {
  TBAMatch,
  TBAEliminationAlliance,
  TBATeamEventStatus,
} from "@/lib/tba/types";

import { formatAllianceShortName, formatRecord, formatTeamNumber, matchCode } from "@/lib/tba/formatters";
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

  return formatAllianceShortName(alliance.name);
}

export default function TeamPill({
  team,
  status,
  nextMatch,
  playoffAlliances = [],
  eventTimezone,
}: {
  team: string;
  status: TBATeamEventStatus | null | undefined;
  nextMatch: TBAMatch | null | undefined;
  playoffAlliances?: TBAEliminationAlliance[];
  playoffType?: number | null;
  eventTimezone?: string | null;
}) {
  const record = status?.qual?.ranking?.record;
  const teamNumber = formatTeamNumber(team);

  const recordLabel = formatRecord(record);

  const alliance = allianceLabel(
    team,
    playoffAlliances,
  );

  const rankLabel = alliance
    ? alliance
    : status?.qual?.ranking?.rank
      ? `#${status.qual.ranking.rank}`
      : "—";

  const nextMatchLabel = nextMatch ? matchCode(nextMatch.key) : null;

  return (
    <div className="flex h-7 items-center gap-1.5 rounded-md border border-white/10 bg-neutral-950/90 px-2 shadow-lg backdrop-blur">
      <span className="font-mono text-[11px] font-bold">
        {teamNumber}
      </span>

      <span className="font-mono text-xs font-semibold text-neutral-100">
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
              <NextMatchCountdown nextMatch={nextMatch} eventTimezone={eventTimezone} />
            </span>
          )}
        </>
      )}
    </div>
  );
}
