"use client";

import type { FieldViewMatch, FieldViewPlayoffAlliance } from "@fieldview/domain";
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

const MATCH_FLAG_LABELS: Record<string, string> = {
  "model-upset": "Model Upset",
  "anomalous-score": "Anomalous Score",
};

const PREDICTION_TONES: Record<string, string> = {
  "Strong Red": "bg-rose-700 text-white",
  "Lean Red": "bg-rose-950 text-rose-200",
  "Toss-up": "bg-slate-700 text-slate-100",
  "Lean Blue": "bg-blue-950 text-blue-200",
  "Strong Blue": "bg-blue-700 text-white",
};

function MatchReviewFlagPills({ flags }: { flags: string[] }) {
  return flags.map((flag) => (
    <span
      key={flag}
      title={MATCH_FLAG_LABELS[flag] ?? flag}
      className="inline-flex shrink-0 rounded-full bg-amber-950 px-1 py-px text-[8px] font-bold leading-3 text-amber-200"
    >
      {MATCH_FLAG_LABELS[flag] ?? flag}
    </span>
  ));
}

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
  const matchLevelFlags = hasResult
    ? (match.flags?.review_flags ?? []).filter(
        (flag) => flag === "model-upset" || flag === "anomalous-score"
      )
    : [];

  const prediction = match.flags?.prediction ?? null;
  const predictionLabel = prediction?.label ?? "Toss-up";
  const predictionTone = PREDICTION_TONES[predictionLabel] ?? PREDICTION_TONES["Toss-up"];

  const time = hasResult
    ? match.actual_time != null
      ? formatMatchEventTime(match.actual_time, eventTimezone)
      : match.time != null
        ? formatMatchEventTime(match.time, eventTimezone)
        : null
    : match.predicted_time != null
      ? formatMatchEventTime(match.predicted_time, eventTimezone)
      : match.time != null
        ? formatMatchEventTime(match.time, eventTimezone)
        : null;

  const redPredictedScore = match.predictions.statbotics?.red_score;
  const bluePredictedScore = match.predictions.statbotics?.blue_score;
  const displayedRedScore = hasResult ? redScore : redPredictedScore;
  const displayedBlueScore = hasResult ? blueScore : bluePredictedScore;

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
          borderClass,
          resultBackground ?? (isNext ? "bg-zinc-900" : "bg-zinc-950"),
        ].join(" ")}
      >
        <div className="grid grid-cols-[92px_minmax(0,1fr)_30px] items-center gap-x-2 leading-none">
          {/* Match name, prediction strength, and result review flags */}
          <div className="relative top-px row-span-2 flex h-full flex-col justify-center">
            <span
              className={[
                "whitespace-nowrap text-[10px] font-bold uppercase tracking-wide",
                isNext ? "text-white" : "text-zinc-300",
              ].join(" ")}
            >
              {matchName}
            </span>

            <div className="mt-1 flex min-h-[14px] flex-wrap items-center gap-1">
              <span
                className={`inline-flex rounded-full px-1.5 py-0.5 text-[8px] font-bold leading-3 ${predictionTone}`}
                title={prediction ? `Predicted outcome: ${prediction.label}` : "Prediction unavailable"}
              >
                {predictionLabel}
              </span>
              {hasResult && matchLevelFlags.length > 0 ? (
                <MatchReviewFlagPills flags={matchLevelFlags} />
              ) : (
                <span className="whitespace-nowrap font-mono text-[9px] tabular-nums text-zinc-500">
                  {time}
                </span>
              )}
            </div>
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
            {displayedRedScore != null && displayedRedScore >= 0 ? (
              hasResult ? (
                <span className="font-bold text-red-400">{displayedRedScore}</span>
              ) : (
                <span
                  title={`Predicted red score: ${displayedRedScore}`}
                  className="inline-flex min-w-[28px] justify-center rounded border border-zinc-600 bg-zinc-800 px-1 py-0.5 font-bold text-zinc-200"
                >
                  {Math.round(displayedRedScore)}
                </span>
              )
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
            {displayedBlueScore != null && displayedBlueScore >= 0 ? (
              hasResult ? (
                <span className="font-bold text-blue-400">{displayedBlueScore}</span>
              ) : (
                <span
                  title={`Predicted blue score: ${displayedBlueScore}`}
                  className="inline-flex min-w-[28px] justify-center rounded border border-zinc-600 bg-zinc-800 px-1 py-0.5 font-bold text-zinc-200"
                >
                  {Math.round(displayedBlueScore)}
                </span>
              )
            ) : null}
          </div>
        </div>
      </article>
    </div>
  );
}
