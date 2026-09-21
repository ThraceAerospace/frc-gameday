"use client";

import type { TBAMatch } from "@/lib/tba/types";
import NextMatchCountdown from "./NextMatchCountdown";
import { formatAlliance } from "@/lib/tbaFormatters";
import { formatEventTime } from "@/lib/time";

type PlayoffAlliance = {
  name?: string;
  picks?: string[];
};

type MatchCardProps = {
  match: TBAMatch;
  team?: string[];
  isNext?: boolean;
  isLast?: boolean;
  playoffAlliances?: PlayoffAlliance[];
  playoffType?: number | null;
  eventTimezone?: string;
};

function compactMatchName(
  match: TBAMatch,
  playoffType: number | null
): string {
  const level = match.comp_level.toLowerCase();
  const number = match.match_number;
  const set = match.set_number;

  switch (level) {
    case "qm":
      return `Qual ${number}`;

    case "ef":
      return set != null ? `EF${set}-${number}` : `EF${number}`;

    case "qf":
      return set != null ? `QF${set}-${number}` : `QF${number}`;

    case "sf":
      switch (playoffType) {
        case 10:
            return `Playoff ${set ?? number}`;
        case 11:
          return `Playoff ${set ?? number}`;

        case 4:
          return `Round Robin ${number}`;

        default:
          return set != null
            ? `SF${set}-${number}`
            : `SF${number}`;
      }

    case "f":
      return `Final ${number}`;

    default:
      return `${level.toUpperCase()}${number}`;
  }
}

function getAllianceName(
  alliance: PlayoffAlliance | null
): string {
  if (!alliance?.name) return "";

  return `${alliance.name.replace("Alliance ", "A")} `;
}

export default function MatchCard({
  match,
  team = [],
  isNext = false,
  isLast = false,
  playoffAlliances = [],
  playoffType = null,
  eventTimezone,
}: MatchCardProps) {
  const red = match.alliances.red.team_keys;
  const blue = match.alliances.blue.team_keys;

  const trackedRed = red.some((key) => team.includes(key));
  const trackedBlue = blue.some((key) => team.includes(key));

  const isElimination = match.comp_level !== "qm";

  const redAlliance = isElimination
    ? playoffAlliances.find((alliance) =>
        alliance.picks?.some((pick) => red.includes(pick))
      ) ?? null
    : null;

  const blueAlliance = isElimination
    ? playoffAlliances.find((alliance) =>
        alliance.picks?.some((pick) => blue.includes(pick))
      ) ?? null
    : null;

  const matchName = compactMatchName(match, playoffType);

  const time =
    isNext && match.predicted_time != null ? (
      <NextMatchCountdown nextMatch={match} />
    ) : match.actual_time != null ? (
      formatEventTime(match.actual_time, eventTimezone)
    ) : match.predicted_time != null ? (
      formatEventTime(match.predicted_time, eventTimezone)
    ) : null;
  return (
    <article
      className={[
        "shrink-0",
        "min-w-[204px]",
        "rounded-md",
        "border",
        "px-2 py-1",
        "transition-colors",
        isNext
          ? "border-zinc-500 bg-zinc-900"
          : isLast
            ? "border-zinc-700 bg-zinc-900/80"
            : "border-zinc-800 bg-zinc-950",
      ].join(" ")}
    >
      <div className="grid grid-cols-[65px_minmax(0,1fr)_24px] items-center gap-x-2 leading-none">
        {/* Match name */}
        <div className="row-span-2 flex h-full flex-col justify-center">
          <span
            className={[
              "text-[10px] font-bold uppercase tracking-wide",
              isNext ? "text-white" : "text-zinc-300",
            ].join(" ")}
          >
            {matchName}
          </span>

          <span
            className={[
              "mt-1 font-mono text-[9px] tabular-nums",
              isNext
                ? "font-semibold text-zinc-200"
                : "text-zinc-500",
            ].join(" ")}
          >
            {time}
          </span>
        </div>

        {/* Red alliance */}
        <div
          className={[
            "min-w-0 truncate text-[10px] text-red-400",
            trackedRed ? "font-bold" : "font-medium",
          ].join(" ")}
        >
          {getAllianceName(redAlliance)}
          {formatAlliance(red, team)}
        </div>

        {/* Red score */}
        <div
          className={[
            "text-right font-mono text-[10px] tabular-nums",
            match.alliances.red.score != null
              ? "font-bold text-red-400"
              : "text-transparent",
          ].join(" ")}
        >
          {match.alliances.red.score != -1 ? match.alliances.red.score : ""}
        </div>

        {/* Blue alliance */}
        <div
          className={[
            "min-w-0 truncate text-[10px] text-blue-400",
            trackedBlue ? "font-bold" : "font-medium",
          ].join(" ")}
        >
          {getAllianceName(blueAlliance)}
          {formatAlliance(blue, team)}
        </div>

        {/* Blue score */}
        <div
          className={[
            "text-right font-mono text-[10px] tabular-nums",
            match.alliances.blue.score != null
              ? "font-bold text-blue-400"
              : "text-transparent",
          ].join(" ")}
        >
          {match.alliances.blue.score != -1 ? match.alliances.blue.score : ""}
        </div>
      </div>
    </article>
  );
}