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
  priorityEditing = false,
  activeHighlighted = false,
  imminentMatch = false,
}: {
  team: string;
  status: TBATeamEventStatus | null | undefined;
  nextMatch: TBAMatch | null | undefined;
  playoffAlliances?: TBAEliminationAlliance[];
  eventTimezone?: string | null;
  playoffType?: number | null;
  priorityEditing?: boolean;
  activeHighlighted?: boolean;
  imminentMatch?: boolean;
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
            {formatRecord(playoff.current_level_record, { eliminated: isEliminated })}
          </span>
        )
    : formatRecord(record, { eliminated: isEliminated });

  const rankLabel = alliance
    ? alliance
    : status?.qual?.ranking?.rank
      ? `#${status.qual.ranking.rank}`
      : "—";

  const nextMatchLabel = nextMatch ? matchAbbreviationName(nextMatch, playoffType) : null;

  return (
    <div className={`relative z-30 box-border -mb-px flex h-6 items-center gap-1.5 rounded-t-lg border-x border-t ${priorityEditing ? "border-blue-500/90 shadow-[0_0_12px_rgba(59,130,246,0.12)]" : imminentMatch ? "!border-[var(--tracked-accent)] tracked-accent-glow" : activeHighlighted ? "border-white shadow-[0_0_12px_rgba(255,255,255,0.12)]" : "border-white/10"} bg-neutral-950 px-2 shadow-lg backdrop-blur`}>
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
