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
  const redAllianceFlags = match.flags?.alliances.red ?? [];
  const blueAllianceFlags = match.flags?.alliances.blue ?? [];
  const matchFlagTitle = matchLevelFlags.join(", ");
  const redFlagTitle = redAllianceFlags.map((flag) => flag.type).join(", ");
  const blueFlagTitle = blueAllianceFlags.map((flag) => flag.type).join(", ");
  const redTeamTextLength = red.map(formatTeamNumber).join(" ").length;
  const blueTeamTextLength = blue.map(formatTeamNumber).join(" ").length;
  const redTeamFontSize = Math.min(
    12,
    (116 - (redAllianceFlags.length > 0 ? 10 : 0)) / Math.max(1, redTeamTextLength * 0.62),
  );
  const blueTeamFontSize = Math.min(
    12,
    (116 - (blueAllianceFlags.length > 0 ? 10 : 0)) / Math.max(1, blueTeamTextLength * 0.62),
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
              ? "grid-cols-[max-content_116px_max-content]"
              : "grid-cols-[max-content_116px]",
          ].join(" ")}
        >
          {/* Match identity and restored clock */}
          <div className="relative top-px row-span-2 flex h-full min-w-max flex-col justify-center">
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              {matchLevelFlags.length > 0 ? (
                <span
                  aria-label="Match has review flags"
                  title={matchFlagTitle}
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                />
              ) : null}
              <span
                className={[
                  "whitespace-nowrap text-[10px] font-bold uppercase tracking-wide",
                  isNext ? "text-white" : "text-zinc-300",
                ].join(" ")}
              >
                {matchName}
              </span>
            </div>

            <span
              className={[
                "mt-1 whitespace-nowrap font-mono text-[10px] tabular-nums",
                isNext ? "font-semibold text-zinc-200" : "text-zinc-500",
              ].join(" ")}
            >
              {time}
            </span>
          </div>

          {/* Fixed-width alliance roster: 3 five-digit numbers plus spaces */}
          <div className="row-span-2 flex w-[116px] flex-col justify-center gap-y-0.5">
            <div className="flex h-[14px] min-w-0 items-center gap-1 whitespace-nowrap">
              {redAllianceFlags.length > 0 ? (
                <span
                  aria-label="Red alliance has flags"
                  title={redFlagTitle}
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                />
              ) : null}
              <div
                className={[
                  "min-w-0 flex-1 overflow-hidden whitespace-nowrap font-mono leading-[14px] text-red-400",
                  trackedRed ? "font-bold" : "font-medium",
                ].join(" ")}
                style={{ fontSize: `${redTeamFontSize}px` }}
                title={`${formatAllianceShortName(redAlliance?.name)} ${red.map(formatTeamNumber).join(" ")}`.trim()}
              >
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

            <div className="flex h-[14px] min-w-0 items-center gap-1 whitespace-nowrap">
              {blueAllianceFlags.length > 0 ? (
                <span
                  aria-label="Blue alliance has flags"
                  title={blueFlagTitle}
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                />
              ) : null}
              <div
                className={[
                  "min-w-0 flex-1 overflow-hidden whitespace-nowrap font-mono leading-[14px] text-blue-400",
                  trackedBlue ? "font-bold" : "font-medium",
                ].join(" ")}
                style={{ fontSize: `${blueTeamFontSize}px` }}
                title={`${formatAllianceShortName(blueAlliance?.name)} ${blue.map(formatTeamNumber).join(" ")}`.trim()}
              >
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
            <div className="row-span-2 flex flex-col items-end justify-center gap-y-0.5 text-right font-mono text-[10px] tabular-nums">
              {hasResult ? (
                <>
                  <span className="font-bold text-red-400">{redScore}</span>
                  <span className="font-bold text-blue-400">{blueScore}</span>
                </>
              ) : showWinProbability ? (
                <>
                  <span
                    title={`Red win probability: ${Math.round(redWinProbability! * 100)}%`}
                    className="inline-flex min-w-[38px] justify-center rounded-sm border border-zinc-600 bg-zinc-800 px-1 py-0.5 font-bold text-red-300"
                  >
                    {Math.round(redWinProbability! * 100)}%
                  </span>
                  <span
                    title={`Blue win probability: ${Math.round((1 - redWinProbability!) * 100)}%`}
                    className="inline-flex min-w-[38px] justify-center rounded-sm border border-zinc-600 bg-zinc-800 px-1 py-0.5 font-bold text-blue-300"
                  >
                    {Math.round((1 - redWinProbability!) * 100)}%
                  </span>
                </>
              ) : (
                <>
                  <span
                    title={`Predicted red score: ${redPredictedScore}`}
                    className="inline-flex min-w-[28px] justify-center rounded border border-zinc-600 bg-zinc-800 px-1 py-0.5 font-bold text-zinc-200"
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
