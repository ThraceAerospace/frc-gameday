"use client";

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

function flattenFields(value: unknown, prefix = ""): Map<string, unknown> {
  const fields = new Map<string, unknown>();

  if (value === null || typeof value !== "object") {
    if (prefix) fields.set(prefix, value);
    return fields;
  }

  if (Array.isArray(value)) {
    if (value.length === 0 && prefix) fields.set(prefix, value);
    value.forEach((item, index) => {
      const childPrefix = prefix ? `${prefix}.${index + 1}` : String(index + 1);
      for (const [key, childValue] of flattenFields(item, childPrefix)) {
        fields.set(key, childValue);
      }
    });
    return fields;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 && prefix) fields.set(prefix, value);

  for (const [key, childValue] of entries) {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    for (const [fieldKey, fieldValue] of flattenFields(childValue, childPrefix)) {
      fields.set(fieldKey, fieldValue);
    }
  }

  return fields;
}

function isInactive(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0) return true;
  if (typeof value === "string") {
    return value.trim() === "" || value.trim().toLowerCase() === "none";
  }
  return Array.isArray(value) && value.length === 0;
}

function fieldOrder(key: string): number {
  const normalized = key.toLowerCase().replace(/[._-]/g, " ");

  if (/\b(total|score)\b/.test(normalized) && /(total|score|points)/.test(normalized)) return 0;
  if (/\b(rp|ranking point|ranking points)\b/.test(normalized) || /_rp\b/.test(key)) return 1;
  if (/(foul|penalt|adjustment|disqualification|\bdq\b)/.test(normalized)) return 3;
  if (/(point|score|fuel|piece|tower|auto|teleop|endgame|shift|amp|speaker|coral|algae|stage|climb|park|trap|leave|mobility|charge|dock|note|cube|cone)/.test(normalized)) return 2;
  return 4;
}

function compareFieldKeys(left: string, right: string): number {
  const orderDifference = fieldOrder(left) - fieldOrder(right);
  if (orderDifference !== 0) return orderDifference;

  const leftParts = left.toLowerCase().split(".");
  const rightParts = right.toLowerCase().split(".");
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === b) continue;
    const aNumber = Number(a);
    const bNumber = Number(b);
    if (a !== "" && b !== "" && Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
      return aNumber - bNumber;
    }
    return a.localeCompare(b);
  }
  return leftParts.length - rightParts.length;
}

function getAllianceFields(breakdown: unknown): FieldRow[] {
  if (!breakdown || typeof breakdown !== "object") return [];
  const sides = breakdown as Record<string, unknown>;
  const red = sides.red;
  const blue = sides.blue;
  if (!red || typeof red !== "object" || !blue || typeof blue !== "object") return [];

  const redFields = flattenFields(red);
  const blueFields = flattenFields(blue);
  const keys = [...new Set([...redFields.keys(), ...blueFields.keys()])];

  return keys
    .filter((key) => !/threshold/i.test(key))
    .filter((key) => !isInactive(redFields.get(key)) || !isInactive(blueFields.get(key)))
    .sort(compareFieldKeys)
    .map((key) => ({
      key,
      label: key.split(".").map(formatLabel).join(" · "),
      red: redFields.get(key),
      blue: blueFields.get(key),
    }));
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
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

  const fields = getAllianceFields(breakdown);
  if (fields.length === 0) return null;

  return (
    <section className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-300">
        Official score breakdown{year ? ` · ${year}` : ""}
      </h2>
      <div className="mb-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)] items-center gap-3 text-xs font-bold uppercase tracking-wider">
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
