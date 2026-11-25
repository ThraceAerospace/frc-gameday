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

function zonedMidnight(value: string, timeZone: string): number | null {
  if (!validDateOnly(value)) return null;
  const date = new Date(value + "T00:00:00.000Z");
  const target = date.getTime();
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, calendar: "gregory", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    let candidate = target;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const values = new Map(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
      const represented = Date.UTC(
        Number(values.get("year")), Number(values.get("month")) - 1, Number(values.get("day")),
        Number(values.get("hour")), Number(values.get("minute")), Number(values.get("second")),
      );
      const adjustment = target - represented;
      if (adjustment === 0) return candidate;
      candidate += adjustment;
    }
  } catch {
    return null;
  }
  return null;
}

export interface EventLifecycleDecision {
  lifecycle: "upcoming" | "active" | "completed" | "expired";
  completedUntil?: number;
}

export function isValidEventLifecycleInput(event: Pick<TbaEvent, "start_date" | "end_date" | "timezone">): boolean {
  if (!validDateOnly(event.start_date) || !validDateOnly(event.end_date) ||
      event.start_date > event.end_date || typeof event.timezone !== "string" || !event.timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: event.timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Match EventRuntime's existing timezone-aware lifecycle and 24-hour retention policy. */
export function lifecycleFor(event: TbaEvent, now: number): EventLifecycleDecision {
  if (!isValidEventLifecycleInput(event)) return { lifecycle: "expired" };
  const start = zonedMidnight(event.start_date, event.timezone);
  const endExclusive = zonedMidnight(addDays(event.end_date, 1), event.timezone);
  if (start === null || endExclusive === null || endExclusive <= start) return { lifecycle: "expired" };
  const end = endExclusive - 1;
  if (now < start) return { lifecycle: "upcoming" };
  if (now <= end) return { lifecycle: "active" };
  const completedUntil = end + 24 * 60 * 60_000;
  return now < completedUntil ? { lifecycle: "completed", completedUntil } : { lifecycle: "expired" };
}
