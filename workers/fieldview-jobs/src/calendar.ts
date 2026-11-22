export interface TbaEvent {
  key: string;
  start_date: string;
  end_date: string;
  timezone: string;
  [key: string]: unknown;
}

export interface WeekClassification {
  localDate: string;
  weekStart: string;
  weekEnd: string;
  isThisWeek: boolean;
}

function validDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addDays(value: string, days: number): string {
  const date = new Date(value + "T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Inclusive date-only overlap against the Monday-Sunday week in the event timezone. */
export function classifyEventThisWeek(
  event: Pick<TbaEvent, "start_date" | "end_date" | "timezone">,
  now: number,
): WeekClassification | null {
  if (!validDateOnly(event.start_date) || !validDateOnly(event.end_date) ||
      event.start_date > event.end_date || typeof event.timezone !== "string" || !event.timezone) return null;
  let localDate: string;
  try {
    const parts = new Map(new Intl.DateTimeFormat("en-US", {
      timeZone: event.timezone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(now)).map((part) => [part.type, part.value]));
    localDate = String(parts.get("year")).padStart(4, "0") + "-" +
      String(parts.get("month")).padStart(2, "0") + "-" + String(parts.get("day")).padStart(2, "0");
  } catch {
    return null;
  }
  const weekday = new Date(localDate + "T00:00:00.000Z").getUTCDay();
  const weekStart = addDays(localDate, -((weekday + 6) % 7));
  const weekEnd = addDays(weekStart, 6);
  return { localDate, weekStart, weekEnd, isThisWeek: event.start_date <= weekEnd && event.end_date >= weekStart };
}

export function lifecycleFor(event: TbaEvent, now: number): "upcoming" | "active" | "completed" {
  const classification = classifyEventThisWeek(event, now);
  if (!classification) return "completed";
  if (classification.localDate < event.start_date) return "upcoming";
  if (classification.localDate <= event.end_date) return "active";
  return "completed";
}
