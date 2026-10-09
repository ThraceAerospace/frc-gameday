"use client";

import type { ReactNode } from "react";
import type { TBAMatch } from "@/lib/tba/types";

type ScoreBreakdownProps = {
  match: TBAMatch;
  year?: number;
};

function formatLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function renderValue(value: unknown): ReactNode {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.map((item, index) => (
          <span key={index} className="rounded bg-white/[0.06] px-1.5 py-0.5 text-xs">
            {typeof item === "object" && item !== null ? JSON.stringify(item) : String(item)}
          </span>
        ))}
      </div>
    );
  }

  if (typeof value === "object") {
    return (
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        {Object.entries(value).map(([key, nestedValue]) => (
          <div key={key} className="min-w-0">
            <dt className="text-xs text-neutral-500">{formatLabel(key)}</dt>
            <dd className="mt-0.5 break-words text-sm tabular-nums text-neutral-200">
              {renderValue(nestedValue)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return String(value);
}

export default function ScoreBreakdown({ match, year }: ScoreBreakdownProps) {
  const breakdown = match.score_breakdown;
  const redScore = match.alliances.red.score;
  const blueScore = match.alliances.blue.score;
  const scoresPosted =
    typeof redScore === "number" &&
    redScore >= 0 &&
    typeof blueScore === "number" &&
    blueScore >= 0;

  if (!breakdown || !scoresPosted) return null;

  return (
    <section className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-300">
        Official score breakdown{year ? ` · ${year}` : ""}
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(["red", "blue"] as const).map((color) => (
          <section
            key={color}
            className={`min-w-0 rounded-lg border p-3 ${color === "red" ? "border-red-400/20 bg-red-950/10" : "border-blue-400/20 bg-blue-950/10"}`}
          >
            <h3 className={`mb-3 text-xs font-bold uppercase ${color === "red" ? "text-red-300" : "text-blue-300"}`}>
              {color} alliance
            </h3>
            {renderValue(breakdown[color])}
          </section>
        ))}
      </div>
    </section>
  );
}
