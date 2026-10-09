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

type FieldSection = {
  key: string;
  label: string;
  order: number;
  fields: FieldRow[];
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

  const entries = Object.entries(value);
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
    const normalized = value.trim().toLowerCase();
    return normalized === "" || normalized === "none" || normalized === "no";
  }
  return Array.isArray(value) && value.length === 0;
}

function compareFieldKeys(left: string, right: string): number {
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

function sectionForField(field: FieldRow): { key: string; label: string; order: number } {
  const separator = field.key.indexOf(".");
  if (separator >= 0) {
    const parent = field.key.slice(0, separator);
    const normalizedParent = parent.toLowerCase();
    const order = /(penalt|foul|adjust)/.test(normalizedParent)
      ? 5
      : /(endgame|tower|climb|stage)/.test(normalizedParent)
        ? 3
        : /(auto|autonomous)/.test(normalizedParent)
          ? 1
          : /(teleop|hub|shift|transition)/.test(normalizedParent)
            ? 2
            : 4;
    return { key: `group:${parent}`, label: formatLabel(parent), order };
  }

  const normalized = field.key.toLowerCase().replace(/[_-]/g, " ");
  if (/(foul|penalt|adjustment|disqualification|\bdq\b)/.test(normalized)) {
    return { key: "penalties", label: "Penalties & adjustments", order: 5 };
  }
  if (/(ranking point|\brp\b|_rp\b)/.test(normalized)) {
    return { key: "ranking-points", label: "Ranking points", order: 4 };
  }
  if (/(auto|autonomous)/.test(normalized)) {
    return { key: "autonomous", label: "Autonomous", order: 1 };
  }
  if (/(teleop|transition|shift)/.test(normalized)) {
    return { key: "teleop", label: "Teleoperated", order: 2 };
  }
  if (/(endgame|tower|climb|stage|park|traversal)/.test(normalized)) {
    return { key: "endgame", label: "Endgame", order: 3 };
  }
  if (/(total|score|points)/.test(normalized)) {
    return { key: "totals", label: "Scoring totals", order: 6 };
  }
  return { key: "other", label: "Other details", order: 7 };
}

function groupFields(fields: FieldRow[]): FieldSection[] {
  const sections = new Map<string, FieldSection>();

  for (const field of fields) {
    const section = sectionForField(field);
    const existing = sections.get(section.key);
    if (existing) {
      existing.fields.push(field);
    } else {
      sections.set(section.key, { ...section, fields: [field] });
    }
  }

  return [...sections.values()].sort(
    (left, right) => left.order - right.order || left.label.localeCompare(right.label),
  );
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

  const sections = groupFields(getAllianceFields(breakdown));
  if (sections.length === 0) return null;

  return (
    <section className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-neutral-300">
        Official score breakdown{year ? ` · ${year}` : ""}
      </h2>
      <div className="mb-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)] items-center gap-3 px-2 text-[10px] font-bold uppercase tracking-wider">
        <div className="text-left text-red-300">Red</div>
        <div className="text-center text-neutral-500">Scoring detail</div>
        <div className="text-right text-blue-300">Blue</div>
      </div>
      <div className="space-y-3">
        {sections.map((section) => (
          <div key={section.key} className="overflow-hidden rounded-lg border border-white/[0.07]">
            <h3 className="border-b border-white/[0.07] bg-white/[0.035] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-300">
              {section.label}
            </h3>
            <div className="divide-y divide-white/[0.04] px-3">
              {section.fields.map((field) => (
                <div
                  key={field.key}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)] items-center gap-3 py-2"
                >
                  <div className="break-words text-left text-sm font-medium tabular-nums text-red-200">
                    {renderCell(field.red)}
                  </div>
                  <div className="break-words text-center text-xs text-neutral-400">
                    {field.label}
                  </div>
                  <div className="break-words text-right text-sm font-medium tabular-nums text-blue-200">
                    {renderCell(field.blue)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
