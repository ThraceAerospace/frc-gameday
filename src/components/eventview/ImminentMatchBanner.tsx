"use client";

import { useEffect, useMemo, useState } from "react";
import type { TBAMatch } from "@/lib/tba/types";
import { compactMatchLabel } from "@/lib/tba/matchUtils";
import { matchLongName } from "@/lib/tba/formatters";

type ImminentMatchBannerProps = {
  match: TBAMatch;
  teams: string[];
  eventName: string;
};

function formatCountdown(targetSeconds: number, now: number) {
  const remaining = Math.max(
    0,
    targetSeconds - Math.floor(now / 1000),
  );

  if (remaining <= 0) {
    return "now";
  }

  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;

  if (hours > 0) {
    return `in ${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `in ${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }

  return `in ${seconds}s`;
}

export default function ImminentMatchBanner({
  match,
  teams,
  eventName,
}: ImminentMatchBannerProps) {
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const [visible, setVisible] = useState(true);

  const matchTime = match.predicted_time ?? match.time ?? null;
  const matchLabel = matchLongName(match) ?? match.key;
  const teamLabel = useMemo(
    () =>
      teams
        .map((team) => team.replace(/^frc/i, ""))
        .join(" & "),
    [teams],
  );

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const enterFrame = window.requestAnimationFrame(() => {
      setExpanded(true);
    });

    const collapseTimer = window.setTimeout(() => {
      setExpanded(false);
    }, 7500);

    const hideTimer = window.setTimeout(() => {
      setVisible(false);
    }, 8000);

    return () => {
      window.cancelAnimationFrame(enterFrame);
      window.clearTimeout(collapseTimer);
      window.clearTimeout(hideTimer);
    };
  }, [match.key]);

  if (!visible) {
    return null;
  }

  const countdown =
    matchTime == null
      ? "soon"
      : formatCountdown(matchTime, now);

  return (
    <div
      className={[
        "pointer-events-none absolute inset-x-0 top-0 z-40 overflow-hidden",
        "transition-[max-height,transform,opacity] duration-500 ease-out",
        expanded
          ? "max-h-28 translate-y-0 opacity-100"
          : "max-h-0 -translate-y-3 opacity-0",
      ].join(" ")}
    >
      <div className="border-b border-amber-400/80 bg-amber-950/95 px-4 py-3 shadow-[0_8px_30px_rgba(245,158,11,0.2)] backdrop-blur-md">
        <div className="mx-auto flex min-w-0 items-center justify-center gap-2 text-center text-sm font-semibold text-amber-50">
          <span className="truncate">
            Team {teamLabel} is playing in {matchLabel} at {eventName}
          </span>
          <span className="shrink-0 font-mono text-amber-200">
            {countdown}
          </span>
        </div>
      </div>
    </div>
  );
}
