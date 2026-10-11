"use client";

import { useSharedSecondClock } from "@/lib/time/sharedSecondClock";
import type { TBAMatch } from "@/lib/tba/types";

type NextMatchCountdownProps = {
  nextMatch: TBAMatch;
  eventTimezone?: string | null;
};

export default function NextMatchCountdown({
  nextMatch,
  eventTimezone,
}: NextMatchCountdownProps) {
  const now = useSharedSecondClock();

  const matchTime = nextMatch.predicted_time ?? nextMatch.time;
  if (matchTime == null) {
    return null;
  }

  const target = matchTime * 1_000;

  const seconds = Math.max(
    0,
    Math.round((target - now) / 1_000)
  );

  const nowDate = new Date(now);
  const targetDate = new Date(target);

  const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: eventTimezone ?? undefined,
  });
  const sameDay =
    dateFormatter.format(nowDate) === dateFormatter.format(targetDate);

  const text = !sameDay
    ? targetDate.toLocaleString("en-US", {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: eventTimezone ?? undefined,
      })
    : "~" + (seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.ceil(seconds / 60)}m`
        : `${Math.ceil(seconds / 3600)}h`);

  return <span className="tabular-nums">{text}</span>;
}