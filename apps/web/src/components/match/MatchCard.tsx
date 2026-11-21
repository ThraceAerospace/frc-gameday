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
>;
export type PlayoffAlliancePresentation = Pick<FieldViewPlayoffAlliance, "name" | "picks" | "backup" | "status">;

type AllianceFlag = NonNullable<FieldViewMatch["flags"]>["alliances"]["red"][number];

const MATCH_FLAG_LABELS: Record<string, { short: string; full: string }> = {
  "model-upset": { short: "UPSET", full: "Model Upset" },
  "anomalous-score": { short: "ANOM", full: "Anomalous Score" },
  "large-residual": { short: "DELTA", full: "Large Residual" },
  "high-penalties": { short: "PEN", full: "High Penalties" },
  "high-alliance-epa": { short: "EPA", full: "High Alliance EPA" },
};

function getAllianceFlagPresentation(flags: AllianceFlag[]) {
  // Keep prediction win/loss labels out of the score column: the card border
  // already communicates the predicted winner. Prefer review-worthy findings.
  const priority: AllianceFlag["type"][] = [
    "anomalous-score",
    "high-penalties",
    "large-score-delta",
    "high-alliance-epa",
  ];
  const flag = priority
    .map((type) => flags.find((candidate) => candidate.type === type))
    .find((candidate) => candidate !== undefined);

  if (!flag) return null;

  switch (flag.type) {
    case "anomalous-score":
      return {
        short: "ANOM",
        title: `Anomalous Score · actual ${flag.evidence.actual_score}, predicted ${flag.evidence.predicted_score}`,
      };
    case "high-penalties":
      return {
        short: "PEN+",
        title: `High Penalties · ${flag.evidence.penalty_points} penalty points (threshold ${flag.evidence.event_threshold})`,
      };
    case "large-score-delta":
      return {
        short: "Δ",
        title: `Large Score Delta · ${flag.evidence.delta > 0 ? "+" : ""}${flag.evidence.delta.toFixed(1)} points (threshold ${flag.evidence.event_threshold.toFixed(1)})`,
      };
    case "high-alliance-epa":
      return {
        short: "EPA+",
        title: `High Alliance EPA · ${flag.evidence.pre_match_alliance_epa.toFixed(1)} pre-match EPA (threshold ${flag.evidence.event_threshold.toFixed(1)})`,
      };
    default:
      return null;
  }
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

  const prediction = !hasResult ? match.flags?.prediction : null;
  const predictionBorder = prediction?.predicted_winner
    ? prediction.label.startsWith("Strong")
      ? prediction.predicted_winner === "red"
        ? "border-red-500/90"
        : "border-blue-500/90"
      : prediction.predicted_winner === "red"
        ? "border-red-500/55"
        : "border-blue-500/55"
    : null;

  // Existing Gameday emphasis always wins over the prediction treatment.
  const borderClass = isNext
    ? "border-zinc-400 ring-1 ring-white/20"
    : hasTrackedTeam
      ? "tracked-accent-border"
      : predictionBorder ?? "border-zinc-800";

  const matchName = matchShortName(match, playoffType);
  const reviewFlags = hasResult ? (match.flags?.review_flags ?? []) : [];
  const primaryReviewFlag = reviewFlags[0];
  const primaryReviewLabel = primaryReviewFlag
    ? MATCH_FLAG_LABELS[primaryReviewFlag]
    : null;
  const reviewFlagTitle = reviewFlags
    .map((flag) => MATCH_FLAG_LABELS[flag]?.full ?? flag)
    .join(" · ");

  const time =
    isNext && (match.predicted_time != null || match.time != null) ? (
      <NextMatchCountdown nextMatch={match} eventTimezone={eventTimezone} />
    ) : primaryReviewLabel ? (
      <span
        className="font-semibold text-[var(--fv-review)]"
        title={reviewFlagTitle}
        aria-label={`${reviewFlagTitle}${reviewFlags.length > 1 ? `, plus ${reviewFlags.length - 1} more flags` : ""}`}
      >
        {primaryReviewLabel.short}
        {reviewFlags.length > 1 ? ` +${reviewFlags.length - 1}` : ""}
      </span>
    ) : match.actual_time != null ? (
      formatMatchEventTime(match.actual_time, eventTimezone)
    ) : match.predicted_time != null ? (
      formatMatchEventTime(match.predicted_time, eventTimezone)
    ) : match.time != null ? (
      formatMatchEventTime(match.time, eventTimezone)
    ) : null;

  const redAllianceFlag = redScore == null || redScore < 0
    ? getAllianceFlagPresentation(match.flags?.alliances.red ?? [])
    : null;
  const blueAllianceFlag = blueScore == null || blueScore < 0
    ? getAllianceFlagPresentation(match.flags?.alliances.blue ?? [])
    : null;

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
        <div className="grid grid-cols-[92px_minmax(0,1fr)_44px] items-center gap-x-2 leading-none">
          {/* Match name and compact review flag / event-local time */}
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
            {formatAlliance(red, team)}
          </div>

          {/* Red score, or its highest-ranked available alliance flag */}
          <div
            className={[
              "text-right font-mono text-[10px] tabular-nums",
              redScore != null && redScore >= 0
                ? "font-bold text-red-400"
                : "font-semibold text-red-300",
            ].join(" ")}
            title={redAllianceFlag?.title}
            aria-label={redAllianceFlag?.title}
          >
            {redScore != null && redScore >= 0
              ? redScore
              : redAllianceFlag?.short ?? ""}
          </div>

          {/* Blue alliance */}
          <div
            className={[
              "min-w-0 truncate text-[10px] text-blue-400",
              trackedBlue ? "font-bold" : "font-medium",
            ].join(" ")}
          >
            {formatAllianceShortName(blueAlliance?.name)}
            {formatAlliance(blue, team)}
          </div>

          {/* Blue score, or its highest-ranked available alliance flag */}
          <div
            className={[
              "text-right font-mono text-[10px] tabular-nums",
              blueScore != null && blueScore >= 0
                ? "font-bold text-blue-400"
                : "font-semibold text-blue-300",
            ].join(" ")}
            title={blueAllianceFlag?.title}
            aria-label={blueAllianceFlag?.title}
          >
            {blueScore != null && blueScore >= 0
              ? blueScore
              : blueAllianceFlag?.short ?? ""}
          </div>
        </div>
      </article>
    </div>
  );
}
