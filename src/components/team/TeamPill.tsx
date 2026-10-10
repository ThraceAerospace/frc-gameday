"use client";

import type {
  TBAMatch,
  TBAEliminationAlliance,
  TBATeamEventStatus,
} from "@/lib/tba/types";

import { formatAllianceShortName, formatRecord, formatTeamNumber, matchAbbreviationName } from "@/lib/tba/formatters";
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
  playoffType = null,
}: {
  team: string;
  status: TBATeamEventStatus | null | undefined;
  nextMatch: TBAMatch | null | undefined;
  playoffAlliances?: TBAEliminationAlliance[];
  eventTimezone?: string | null;
  playoffType?: number | null;
}) {
  const record = status?.qual?.ranking?.record;
  const playoff = status?.playoff;
  const teamNumber = formatTeamNumber(team);
  const teamKey = String(team).toLowerCase();
  const isEliminated =
    playoff?.status === "eliminated" ||
    playoffAlliances.some(
      (entry) =>
        entry.status?.status === "eliminated" &&
        entry.picks.some((pick) => String(pick).toLowerCase() === teamKey),
    );

  const alliance = allianceLabel(
    team,
    playoffAlliances,
  );

  // Once a team has been picked into a playoff alliance, show its playoff
  // progress instead of its qualification record. The team status already
  // carries the bracket-specific fields, so no event-level playoff_type is
  // needed here.
  const playoffLevel = playoff?.double_elim_round
    ? playoff.double_elim_round
    : playoff?.level?.toUpperCase();
  const recordLabel = alliance && playoff
    ? playoff.double_elim_round
      ? playoffLevel ?? "—"
      : (
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <span>{playoffLevel ?? "—"}</span>
            {formatRecord(playoff.current_level_record)}
          </span>
        )
    : formatRecord(record);

  const rankLabel = alliance
    ? alliance
    : status?.qual?.ranking?.rank
      ? `#${status.qual.ranking.rank}`
      : "—";

  const nextMatchLabel = nextMatch ? matchAbbreviationName(nextMatch, playoffType) : null;

  return (
    <div className="flex h-7 items-center gap-1.5 rounded-md border border-white/10 bg-neutral-950/90 px-2 shadow-lg backdrop-blur">
      <span className="font-mono text-[11px] font-bold text-neutral-100">
        {teamNumber}
      </span>

      <span className={`font-mono text-[11px] font-semibold ${isEliminated ? "text-red-400" : "text-neutral-100"}`}>
        {recordLabel}
      </span>

      <span className="font-mono text-[11px] text-neutral-300">
        {rankLabel}
      </span>

      {nextMatchLabel && (
        <>
          <span className="h-3 w-px bg-white/10" />

          <span className="font-mono text-[11px] font-bold text-neutral-200">
            {nextMatchLabel}
          </span>

          {nextMatch?.predicted_time != null && (
            <span className="font-mono text-[11px] text-neutral-200">
              <NextMatchCountdown nextMatch={nextMatch} eventTimezone={eventTimezone} />
            </span>
          )}
        </>
      )}
    </div>
  );
}
