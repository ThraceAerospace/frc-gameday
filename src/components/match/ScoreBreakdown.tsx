"use client";

import type { ReactNode } from "react";
import type { TBAMatch } from "@/lib/tba/types";

type ScoreBreakdownProps = {
  match: TBAMatch;
  year?: number;
};

type FieldRow = {
  key: string;
  label: string;
  red: unknown;
  blue: unknown;
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
      <div className="flex flex-wrap justify-center gap-1.5">
        {value.map((item, index) => (
          <span key={index} className="rounded bg-white/[0.06] px-1.5 py-0.5 text-xs">
            {typeof item === "object" && item !== null ? JSON.stringify(item) : String(item)}
          </span>
        ))}
      </div>
    );
  }

  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const childKeys = Object.keys(objectValue);
    return (
      <div className="space-y-2">
        {childKeys.map((key) => (
          <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-3">
            <div className="text-left text-xs text-neutral-500">{formatLabel(key)}</div>
            <div className="min-w-0 break-words text-right text-sm tabular-nums text-neutral-200">
              {renderValue(objectValue[key])}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return String(value);
}

function getAllianceFields(breakdown: unknown): FieldRow[] {
  if (!breakdown || typeof breakdown !== "object") return [];
  const sides = breakdown as Record<string, unknown>;
  const red = sides.red;
  const blue = sides.blue;
  if (!red || typeof red !== "object" || !blue || typeof blue !== "object") return [];

  const redFields = red as Record<string, unknown>;
  const blueFields = blue as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(redFields), ...Object.keys(blueFields)])];

  return keys.map((key) => ({
    key,
    label: formatLabel(key),
    red: redFields[key],
    blue: blueFields[key],
  }));
}

function renderCell(value: unknown): ReactNode {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value !== "object") return String(value);
  return renderValue(value);
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

  const fields = getAllianceFields(breakdown);

  return (
    <section className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-300">
        Official score breakdown{year ? ` · ${year}` : ""}
      </h2>
      <div className="mb-3 grid grid-cols-[1fr_2fr_1fr] items-center gap-3 text-xs font-bold uppercase tracking-wider">
        <div className="text-left text-red-300">Red alliance</div>
        <div className="text-center text-neutral-400">Field</div>
        <div className="text-right text-blue-300">Blue alliance</div>
      </div>
      <div className="divide-y divide-white/[0.06]">
        {fields.map((field) => (
          <div key={field.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)] items-start gap-3 py-2.5">
            <div className="break-words text-left text-sm font-medium tabular-nums text-red-200">
              {renderCell(field.red)}
            </div>
            <div className="break-words text-center text-xs font-medium text-neutral-400">
              {field.label}
            </div>
            <div className="break-words text-right text-sm font-medium tabular-nums text-blue-200">
              {renderCell(field.blue)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
