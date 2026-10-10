"use client";

import type { TBAMatch } from "@/lib/tba/types";
import NextMatchCountdown from "./NextMatchCountdown";
import { formatAlliance, formatAllianceName, matchCode, matchShortName, formatMatchEventTime } from "@/lib/tba/formatters";

type PlayoffAlliance = {
  name?: string;
  picks?: string[];
};

type MatchCardProps = {
  match: TBAMatch;
  team?: string[];
  isNext?: boolean;
  playoffAlliances?: PlayoffAlliance[];
  playoffType?: number | null;
  eventTimezone?: string;
  onOpenInsights?: () => void;
};

export default function MatchCard({
  match,
  team = [],
  isNext = false,
  playoffAlliances = [],
  playoffType = null,
  eventTimezone,
  onOpenInsights,
}: MatchCardProps) {
  const red = match.alliances.red.team_keys;
  const blue = match.alliances.blue.team_keys;

  const trackedRed = red.some((key) => team.includes(key));
  const trackedBlue = blue.some((key) => team.includes(key));
  const hasTrackedTeam = trackedRed || trackedBlue;

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

  const redScore = match.alliances.red.score;
  const blueScore = match.alliances.blue.score;

  const hasResult =
    redScore != null &&
    blueScore != null &&
    redScore >= 0 &&
    blueScore >= 0;

  const resultBackground = !hasResult
    ? null
    : redScore > blueScore
      ? "bg-red-950/50"
      : blueScore > redScore
        ? "bg-blue-950/50"
        : "bg-zinc-800/80";

  const matchName = matchShortName(match, playoffType);

  const time =
    isNext && (match.predicted_time != null || match.time != null) ? (
      <NextMatchCountdown nextMatch={match} eventTimezone={eventTimezone} />
    ) : match.actual_time != null ? (
      formatMatchEventTime(match.actual_time, eventTimezone)
    ) : match.predicted_time != null ? (
      formatMatchEventTime(match.predicted_time, eventTimezone)
    ) : match.time != null ? (
      formatMatchEventTime(match.time, eventTimezone)
    ) : null;
  return (
    <div
      key={match.key}
      data-match-key={match.key}
      className="shrink-0"  
    >
      <article
        className={[
          "shrink-0",
          "min-w-[204px]",
          "rounded-md",
          "border",
          "px-2 py-1",
          "transition-colors",
          isNext
            ? `border-zinc-400 ring-1 ring-white/20 ${resultBackground ?? "bg-zinc-900"}`
            : hasTrackedTeam
              ? `tracked-accent-border ${resultBackground ?? "bg-zinc-950"}`
              : `border-zinc-800 ${resultBackground ?? "bg-zinc-950"}`,
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
            {formatAllianceName(redAlliance?.name)}
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
            {formatAllianceName(blueAlliance?.name)}
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
    </div>
  );
}