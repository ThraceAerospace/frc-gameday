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

const ALLIANCE_FLAG_LABELS: Record<string, { label: string; title: string; className: string }> = {
  "predicted-win": { label: "Predicted Win", title: "Statbotics predicted this alliance to win", className: "border-white/20 bg-white/5 text-zinc-300" },
  "predicted-loss": { label: "Predicted Loss", title: "Statbotics predicted this alliance to lose", className: "border-white/20 bg-white/5 text-zinc-300" },
  "high-alliance-epa": { label: "High Alliance EPA", title: "This alliance's combined pre-match EPA is above the event's 75th-percentile threshold", className: "border-[var(--fv-metric-above)]/60 bg-[var(--fv-metric-above)]/10 text-[var(--fv-metric-above)]" },
  "large-score-delta": { label: "Large Score Delta", title: "This alliance's actual score differed substantially from its predicted score", className: "border-[var(--fv-review)]/60 bg-[var(--fv-review)]/10 text-[var(--fv-review)]" },
  "anomalous-score": { label: "Anomalous Score", title: "This alliance's score residual is unusual for this match phase", className: "border-[var(--fv-review)]/60 bg-[var(--fv-review)]/10 text-[var(--fv-review)]" },
  "high-penalties": { label: "High Penalties", title: "This alliance received an unusually high number of penalty points", className: "border-[var(--fv-review)]/60 bg-[var(--fv-review)]/10 text-[var(--fv-review)]" },
};

function AllianceFlagPills({ flags }: { flags: NonNullable<MatchPresentation["flags"]>["alliances"]["red"] }) {
  return flags.map((flag, index) => {
    const item = ALLIANCE_FLAG_LABELS[flag.type];
    if (!item) return null;
    return <span key={`${flag.type}-${index}`} title={item.title} className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold leading-3 ${item.className}`}>{item.label}</span>;
  });
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
  const modelUpset = hasResult && (match.flags?.review_flags ?? []).includes("model-upset");
  const redAllianceFlags = hasResult ? (match.flags?.alliances.red ?? []) : [];
  const blueAllianceFlags = hasResult ? (match.flags?.alliances.blue ?? []) : [];

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
          "min-w-[232px]",
          "rounded-md",
          "border",
          "px-2 py-1",
          "transition-colors",
          borderClass,
          resultBackground ?? (isNext ? "bg-zinc-900" : "bg-zinc-950"),
        ].join(" ")}
      >
        <div className="grid grid-cols-[92px_minmax(0,1fr)_24px] items-center gap-x-2 leading-none">
          {/* Match name and compact review flag / event-local time */}
          <div className="relative top-px row-span-2 flex h-full flex-col justify-center">
            <span
              className={[
                "whitespace-nowrap text-[10px] font-bold uppercase tracking-wide",
                isNext ? "text-white" : "text-zinc-300",
              ].join(" ")}
            >
              {matchName}
              {modelUpset ? <span title="The match result differed from the model's predicted favorite." className="ml-1 inline-flex items-center rounded-full border border-[var(--fv-review)]/60 bg-[var(--fv-review)]/10 px-1.5 py-0.5 text-[9px] font-semibold leading-3 text-[var(--fv-review)]">Model Upset</span> : null}
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
              "flex min-w-0 items-center gap-1 text-[10px] text-red-400",
              trackedRed ? "font-bold" : "font-medium",
            ].join(" ")}
          >
            <span className="min-w-0 truncate">
              {formatAllianceShortName(redAlliance?.name)}
              {formatAlliance(red, team, match.alliances.red.dq_team_keys ?? [])}
            </span>
            <div className="flex shrink-0 flex-wrap items-center gap-1"><AllianceFlagPills flags={redAllianceFlags} /></div>
          </div>

          {/* Red score */}
          <div
            className={[
              "text-right font-mono text-[10px] tabular-nums",
              redScore != null
                ? "font-bold text-red-400"
                : "text-transparent",
            ].join(" ")}
          >
            {redScore !== -1 ? redScore : ""}
          </div>

          {/* Blue alliance */}
          <div
            className={[
              "flex min-w-0 items-center gap-1 text-[10px] text-blue-400",
              trackedBlue ? "font-bold" : "font-medium",
            ].join(" ")}
          >
            <span className="min-w-0 truncate">
              {formatAllianceShortName(blueAlliance?.name)}
              {formatAlliance(blue, team, match.alliances.blue.dq_team_keys ?? [])}
            </span>
            <div className="flex shrink-0 flex-wrap items-center gap-1"><AllianceFlagPills flags={blueAllianceFlags} /></div>
          </div>

          {/* Blue score */}
          <div
            className={[
              "text-right font-mono text-[10px] tabular-nums",
              blueScore != null
                ? "font-bold text-blue-400"
                : "text-transparent",
            ].join(" ")}
          >
            {blueScore !== -1 ? blueScore : ""}
          </div>
        </div>
      </article>
    </div>
  );
}
