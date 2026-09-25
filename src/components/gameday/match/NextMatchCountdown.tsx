"use client";

import { useEffect, useState } from "react";
import type { TBAMatch } from "@/lib/tba/types";

type NextMatchCountdownProps = {
  nextMatch: TBAMatch;
};

export default function NextMatchCountdown({
  nextMatch,
}: NextMatchCountdownProps) {
  const [, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);

    return () => window.clearInterval(id);
  }, []);

  if (nextMatch.predicted_time == null) {
    return null;
  }

  const now = Date.now();
  const target = nextMatch.predicted_time * 1_000;

  const seconds = Math.max(
    0,
    Math.round(nextMatch.predicted_time - now / 1_000)
  );

  const nowDate = new Date(now);
  const targetDate = new Date(target);

  const sameDay =
    nowDate.toDateString() === targetDate.toDateString();

  const text = !sameDay
    ? targetDate.toLocaleString("en-US", {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.ceil(seconds / 60)}m`
        : `${Math.ceil(seconds / 3600)}h`;

  return <span className="tabular-nums">~{text}</span>;
}