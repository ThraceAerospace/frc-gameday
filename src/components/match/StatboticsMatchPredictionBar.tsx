"use client";

import type { StatboticsPrediction } from "@/lib/statbotics/types";

function formatProbability(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value * 100);
}

export default function MatchPredictionBar({
  prediction,
  status,
  compact = false,
}: {
  prediction: StatboticsPrediction | undefined;
  status: "loading" | "ready" | "unavailable";
  compact?: boolean;
}) {
  const probability = prediction?.red_win_prob;
  const hasProbability = typeof probability === "number" && Number.isFinite(probability);
  const redPercent = hasProbability ? formatProbability(probability) : null;
  const bluePercent = hasProbability ? formatProbability(1 - probability) : null;
  const redWidth = hasProbability ? Math.max(0, Math.min(1, probability)) * 100 : 50;

  return (
    <section className={compact ? "w-full shrink-0 rounded-none px-0 py-0" : "mb-4 rounded-xl p-4 sm:p-5"}>
      {hasProbability ? (
        <div>
          {!compact && (
            <div className="mb-1 flex justify-between text-xs">
              <span className="font-semibold text-red-300">Red {redPercent}%</span>
              <span className="font-semibold text-blue-300">Blue {bluePercent}%</span>
            </div>
          )}
          <div
            className={`flex w-full overflow-hidden rounded-full bg-blue-400/80 ${compact ? "h-1" : "h-3"}`}
            role="img"
            aria-label={`Red win probability ${redPercent} percent; Blue ${bluePercent} percent`}
          >
            <div className="h-full bg-red-500 transition-[width]" style={{ width: `${redWidth}%` }} />
          </div>
        </div>
      ) : (
        <p className={compact ? "px-1 text-[10px] leading-none text-neutral-500" : "text-xs text-neutral-500"}>
          {status === "loading" ? "Loading win probability…" : "Win probability unavailable."}
        </p>
      )}
    </section>
  );
}
