"use client";

import type { StatboticsPrediction } from "@/lib/statbotics/types";

const REWARD_FIELDS = [
  ["energized_rp", "Energized RP"],
  ["supercharged_rp", "Supercharged RP"],
  ["traversal_rp", "Traversal RP"],
] as const;

function formatScore(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(Math.trunc(value))
    : "—";
}

function formatProbability(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value * 100)}%`
    : "—";
}

function getAllianceValue(
  prediction: StatboticsPrediction | undefined,
  color: "red" | "blue",
  field: "score" | "energized_rp" | "supercharged_rp" | "traversal_rp",
): number | undefined {
  if (!prediction) return undefined;
  if (color === "red") {
    switch (field) {
      case "score": return prediction.red_score;
      case "energized_rp": return prediction.red_energized_rp;
      case "supercharged_rp": return prediction.red_supercharged_rp;
      case "traversal_rp": return prediction.red_traversal_rp;
    }
  }
  switch (field) {
    case "score": return prediction.blue_score;
    case "energized_rp": return prediction.blue_energized_rp;
    case "supercharged_rp": return prediction.blue_supercharged_rp;
    case "traversal_rp": return prediction.blue_traversal_rp;
  }
}

function AlliancePredictionBox({
  color,
  prediction,
  compact,
}: {
  color: "red" | "blue";
  prediction: StatboticsPrediction | undefined;
  compact: boolean;
}) {
  const styles = color === "red"
    ? { border: "border-red-400/15", background: "bg-red-950/15", label: "text-red-300/60", value: "text-red-300" }
    : { border: "border-blue-400/15", background: "bg-blue-950/15", label: "text-blue-300/60", value: "text-blue-300" };

  return (
    <div className={`h-full min-w-0 rounded-lg border ${compact ? "px-2 py-0.5" : "px-4 py-3"} ${styles.border} ${styles.background}`}>
      <div className={`grid min-w-0 grid-cols-4 ${compact ? "gap-x-2" : "gap-x-3 gap-y-2"}`}>
        <div className="min-w-0">
          <div className={`font-semibold uppercase ${compact ? "text-[8px] tracking-wide" : "text-[10px] tracking-widest"} ${styles.label}`}>Score</div>
          <div className={`tabular-nums font-semibold ${compact ? "text-sm" : "mt-1 text-3xl"} ${styles.value}`}>{formatScore(getAllianceValue(prediction, color, "score"))}</div>
        </div>
        {REWARD_FIELDS.map(([field, label]) => (
          <div key={field} className="min-w-0">
            <div className={`font-semibold uppercase ${compact ? "text-[8px] tracking-wide" : "text-[10px] tracking-widest"} ${styles.label}`}>{label}</div>
            <div className={`tabular-nums font-semibold ${compact ? "text-sm" : "mt-1 text-3xl"} ${styles.value}`}>{formatProbability(getAllianceValue(prediction, color, field))}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MatchPredictionMetrics({
  prediction,
  compact = false,
}: {
  prediction: StatboticsPrediction | undefined;
  compact?: boolean;
}) {
  return (
    <section className={compact ? "m-0 shrink-0 rounded-none p-0" : "mb-4 rounded-xl border border-white/10 bg-white/[0.02] p-3 sm:p-4"}>
      {!compact && <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-400">Statbotics Prediction</div>}
      <div className={`grid auto-rows-fr grid-cols-1 items-stretch ${compact ? "mt-0 gap-1 sm:grid-cols-2 sm:gap-2" : "gap-3 sm:grid-cols-2 sm:gap-4"}`}>
        <AlliancePredictionBox color="red" prediction={prediction} compact={compact} />
        <AlliancePredictionBox color="blue" prediction={prediction} compact={compact} />
      </div>
    </section>
  );
}
