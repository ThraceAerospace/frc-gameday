import { classifyEventThisWeek } from "./calendar.ts";
import type { TbaEvent } from "./calendar.ts";

export interface EventsThisWeekProjection {
  schemaVersion: 1;
  year: number;
  evaluatedAt: number;
  runDate: string;
  weekStart: string;
  weekEnd: string;
  checkedAt: number;
  events: TbaEvent[];
}

export function utcWeekWindow(timestamp: number): { weekStart: string; weekEnd: string } {
  const date = new Date(timestamp);
  const weekday = date.getUTCDay();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((weekday + 6) % 7));
  const weekStart = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + 6);
  return { weekStart, weekEnd: date.toISOString().slice(0, 10) };
}

/** Build the stable weekly candidate set; lifecycle eligibility remains a dispatch-time decision. */
export function buildEventsThisWeekProjection(
  events: TbaEvent[],
  year: number,
  evaluatedAt: number,
  checkedAt: number,
): EventsThisWeekProjection {
  if (!Number.isInteger(year) || year < 1992 || year > 2200) throw new Error("Invalid projection season");
  if (!Number.isFinite(evaluatedAt) || !Number.isFinite(checkedAt)) throw new Error("Invalid projection timestamps");
  const { weekStart, weekEnd } = utcWeekWindow(evaluatedAt);
  const candidates = events.filter((event) =>
    event && typeof event.key === "string" && /^[a-zA-Z0-9_-]+$/.test(event.key) &&
    classifyEventThisWeek(event, evaluatedAt)?.isThisWeek === true,
  ).sort((a, b) => a.key.localeCompare(b.key));
  return {
    schemaVersion: 1,
    year,
    evaluatedAt,
    runDate: new Date(evaluatedAt).toISOString().slice(0, 10),
    weekStart,
    weekEnd,
    checkedAt,
    events: candidates,
  };
}
