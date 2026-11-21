"use client";

import type { FieldViewMatch, FieldViewPlayoffAlliance } from "@fieldview/domain";
import NextMatchCountdown from "./NextMatchCountdown";
import { formatAlliance, formatAllianceShortName, matchShortName, formatMatchEventTime } from "@/lib/tba/formatters";

export type MatchPresentation = Pick<
  FieldViewMatch,
  | "key"
  | "comp_level"
  | "match_number"
  | "set_number"
  | "alliances"
  | "actual_time"
  | "predicted_time"
  | "time"
  | "flags"
  | "predictions"
>;
export type PlayoffAlliancePresentation = Pick<FieldViewPlayoffAlliance, "name" | "picks" | "backup" | "status">;

export default function MatchCard({
  match,
  team = [],
  isNext = false,
  playoffAlliances = [],
  playoffType = null,
  eventTimezone,
}: {
  match: MatchPresentation;
  team?: string[];
  isNext?: boolean;
  playoffAlliances?: PlayoffAlliancePresentation[];
  playoffType?: number | null;
  eventTimezone?: string;
}) {
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

  const redPredictedScore = match.predictions.statbotics?.red_score;
  const bluePredictedScore = match.predictions.statbotics?.blue_score;

  return (
    <div key={match.key} data-match-key={match.key} className="shrink-0">
      <article
        className={[
          "shrink-0",
          "min-w-[232px]",
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
        <div className="grid grid-cols-[92px_minmax(0,1fr)_30px] items-center gap-x-2 leading-none">
          {/* Match name and time */}
          <div className="relative top-px row-span-2 flex h-full flex-col justify-center">
            <span
              className={[
                "whitespace-nowrap text-[10px] font-bold uppercase tracking-wide",
                isNext ? "text-white" : "text-zinc-300",
              ].join(" ")}
            >
              {matchName}
            </span>

            <span
              className={[
                "mt-1 whitespace-nowrap font-mono text-[10px] tabular-nums",
                isNext ? "font-semibold text-zinc-200" : "text-zinc-500",
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
            {formatAllianceShortName(redAlliance?.name)}
            {formatAlliance(red, team, match.alliances.red.dq_team_keys ?? [])}
          </div>

          {/* Red score */}
          <div className="text-right font-mono text-[10px] tabular-nums">
            {hasResult ? (
              <span className="font-bold text-red-400">{redScore}</span>
            ) : redPredictedScore != null && redPredictedScore >= 0 ? (
              <span
                title={`Predicted red score: ${redPredictedScore}`}
                className="inline-flex min-w-[28px] justify-center rounded border border-zinc-600 bg-zinc-800 px-1 py-0.5 font-bold text-zinc-200"
              >
                {Math.round(redPredictedScore)}
              </span>
            ) : null}
          </div>

          {/* Blue alliance */}
          <div
            className={[
              "min-w-0 truncate text-[10px] text-blue-400",
              trackedBlue ? "font-bold" : "font-medium",
            ].join(" ")}
          >
            {formatAllianceShortName(blueAlliance?.name)}
            {formatAlliance(blue, team, match.alliances.blue.dq_team_keys ?? [])}
          </div>

          {/* Blue score */}
          <div className="text-right font-mono text-[10px] tabular-nums">
            {hasResult ? (
              <span className="font-bold text-blue-400">{blueScore}</span>
            ) : bluePredictedScore != null && bluePredictedScore >= 0 ? (
              <span
                title={`Predicted blue score: ${bluePredictedScore}`}
                className="inline-flex min-w-[28px] justify-center rounded border border-zinc-600 bg-zinc-800 px-1 py-0.5 font-bold text-zinc-200"
              >
                {Math.round(bluePredictedScore)}
              </span>
            ) : null}
          </div>
        </div>
      </article>
    </div>
  );
}
