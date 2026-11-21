"use client";

import type { FieldViewMatch, FieldViewPlayoffAlliance } from "@fieldview/domain";
import NextMatchCountdown from "./NextMatchCountdown";
import { formatAllianceShortName, formatTeamNumber, matchShortName, formatMatchEventTime } from "@/lib/tba/formatters";

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

  const borderClass = isNext
    ? "border-zinc-400 ring-1 ring-white/20"
    : hasTrackedTeam
      ? "tracked-accent-border"
      : "border-zinc-800";

  const matchName = matchShortName(match, playoffType);
  const matchLevelFlags = match.flags?.review_flags ?? [];
  const matchFlagTitle = matchLevelFlags.join(", ");
  const redAllianceLabel = formatAllianceShortName(redAlliance?.name);
  const blueAllianceLabel = formatAllianceShortName(blueAlliance?.name);
  const redTeamText = [redAllianceLabel, red.map(formatTeamNumber).join(" ")]
    .filter(Boolean)
    .join(" ");
  const blueTeamText = [blueAllianceLabel, blue.map(formatTeamNumber).join(" ")]
    .filter(Boolean)
    .join(" ");
  const redTeamFontSize = Math.min(
    14,
    144 / Math.max(1, redTeamText.length * 0.60),
  );
  const blueTeamFontSize = Math.min(
    14,
    144 / Math.max(1, blueTeamText.length * 0.60),
  );

  const prediction = match.flags?.prediction ?? null;
  const redWinProbability = prediction?.red_win_probability;
  const hasWinProbability =
    typeof redWinProbability === "number" &&
    Number.isFinite(redWinProbability) &&
    redWinProbability >= 0 &&
    redWinProbability <= 1;

  const redPredictedScore = match.predictions.statbotics?.red_score;
  const bluePredictedScore = match.predictions.statbotics?.blue_score;
  const hasPredictedScores =
    redPredictedScore != null &&
    bluePredictedScore != null &&
    redPredictedScore >= 0 &&
    bluePredictedScore >= 0;

  // Upcoming matches prioritize the more legible win probability. If it is
  // unavailable, retain the outlined predicted-score treatment.
  const showWinProbability = !hasResult && hasWinProbability;
  const showPredictedScores = !hasResult && !showWinProbability && hasPredictedScores;
  const showRightColumn = hasResult || showWinProbability || showPredictedScores;

  // Preserve the original clock behavior: countdown for the next match,
  // otherwise actual time, then predicted time, then scheduled time.
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
    <div key={match.key} data-match-key={match.key} className="shrink-0">
      <article
        className={[
          "shrink-0",
          "w-fit",
          "rounded-md",
          "border",
          "px-2 py-1",
          "transition-colors",
          borderClass,
          resultBackground ?? (isNext ? "bg-zinc-900" : "bg-zinc-950"),
        ].join(" ")}
      >
        <div
          className={[
            "grid w-fit items-center gap-x-3 leading-none",
            showRightColumn
              ? "grid-cols-[max-content_144px_max-content]"
              : "grid-cols-[max-content_144px]",
          ].join(" ")}
        >
          {/* Match identity and restored clock */}
          <div className="relative top-px row-span-2 flex h-full min-w-max flex-col justify-center">
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              {matchLevelFlags.length > 0 ? (
                <span
                  aria-label="Match has review flags"
                  title={matchFlagTitle}
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400"
                />
              ) : null}
              <span
                className={[
                  "whitespace-nowrap text-[10px] font-medium uppercase tracking-normal",
                  isNext ? "text-white" : "text-zinc-300",
                ].join(" ")}
              >
                {matchName}
              </span>
            </div>

            <span
              className={[
                "mt-0.5 whitespace-nowrap font-mono text-[11px] tabular-nums",
                isNext ? "font-semibold text-zinc-200" : "text-zinc-500",
              ].join(" ")}
            >
              {time}
            </span>
          </div>

          {/* Fixed-width alliance roster with playoff alliance labels */}
          <div className="row-span-2 flex w-[144px] flex-col justify-center gap-y-0.5">
            <div className="flex h-4 min-w-0 items-center whitespace-nowrap">
              <div
                className={[
                  "min-w-0 flex-1 overflow-hidden whitespace-nowrap font-mono leading-4 text-red-400",
                  "font-bold",
                ].join(" ")}
                style={{ fontSize: `${Math.max(10, redTeamFontSize - 2)}px` }}
                title={redTeamText}
              >
                {redAllianceLabel ? (
                  <span className="mr-1 font-sans font-semibold opacity-80">{redAllianceLabel}</span>
                ) : null}
                {red.map((key, index) => (
                  <span
                    key={key}
                    className={[
                      trackedRed ? "font-bold" : "font-medium",
                      (match.alliances.red.dq_team_keys ?? []).includes(key) ? "line-through" : "",
                    ].join(" ")}
                  >
                    {index > 0 ? " " : ""}{formatTeamNumber(key)}
                  </span>
                ))}
              </div>
            </div>

            <div className="flex h-4 min-w-0 items-center whitespace-nowrap">
              <div
                className={[
                  "min-w-0 flex-1 overflow-hidden whitespace-nowrap font-mono leading-4 text-blue-400",
                  "font-bold",
                ].join(" ")}
                style={{ fontSize: `${Math.max(10, blueTeamFontSize - 2)}px` }}
                title={blueTeamText}
              >
                {blueAllianceLabel ? (
                  <span className="mr-1 font-sans font-semibold opacity-80">{blueAllianceLabel}</span>
                ) : null}
                {blue.map((key, index) => (
                  <span
                    key={key}
                    className={[
                      trackedBlue ? "font-bold" : "font-medium",
                      (match.alliances.blue.dq_team_keys ?? []).includes(key) ? "line-through" : "",
                    ].join(" ")}
                  >
                    {index > 0 ? " " : ""}{formatTeamNumber(key)}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Result or prediction column; the grid track is zero-width when empty */}
          {showRightColumn ? (
            <div className="row-span-2 flex flex-col items-end justify-center gap-y-0.5 text-right font-mono tabular-nums">
              {hasResult ? (
                <>
                  <span className="text-sm leading-4 font-bold text-red-400">{redScore}</span>
                  <span className="text-sm leading-4 font-bold text-blue-400">{blueScore}</span>
                </>
              ) : showWinProbability ? (
                <>
                  <span
                    title={`Red win probability: ${Math.round(redWinProbability! * 100)}%`}
                    className="inline-flex min-w-[38px] justify-center rounded-sm border border-zinc-600 bg-zinc-800 px-1 text-xs leading-4 font-bold text-red-300"
                  >
                    {Math.round(redWinProbability! * 100)}%
                  </span>
                  <span
                    title={`Blue win probability: ${Math.round((1 - redWinProbability!) * 100)}%`}
                    className="inline-flex min-w-[38px] justify-center rounded-sm border border-zinc-600 bg-zinc-800 px-1 text-xs leading-4 font-bold text-blue-300"
                  >
                    {Math.round((1 - redWinProbability!) * 100)}%
                  </span>
                </>
              ) : (
                <>
                  <span
                    title={`Predicted red score: ${redPredictedScore}`}
                    className="inline-flex min-w-[28px] justify-center rounded border border-zinc-600 bg-zinc-800 px-1 text-xs leading-4 font-bold text-zinc-200"
                  >
                    {Math.round(redPredictedScore!)}
                  </span>
                  <span
                    title={`Predicted blue score: ${bluePredictedScore}`}
                    className="inline-flex min-w-[28px] justify-center rounded border border-zinc-600 bg-zinc-800 px-1 py-0.5 font-bold text-zinc-200"
                  >
                    {Math.round(bluePredictedScore!)}
                  </span>
                </>
              )}
            </div>
          ) : null}
        </div>
      </article>
    </div>
  );
}
