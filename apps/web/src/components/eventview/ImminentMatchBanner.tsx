"use client";

import { useEffect, useMemo, useState } from "react";
import type { TBAMatch } from "@/lib/tba/types";
import NextMatchCountdown from "@/components/match/NextMatchCountdown";
import { formatTeamNumber, matchLongName } from "@/lib/tba/formatters";

type ImminentMatchBannerProps = {
  match: TBAMatch;
  teams: string[];
  eventName: string;
  eventTimezone: string | null;
  playoffType: number | null;
};

export default function ImminentMatchBanner({
  match,
  teams,
  eventName,
  eventTimezone,
  playoffType,
}: ImminentMatchBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const [visible, setVisible] = useState(true);

  const matchLabel = matchLongName(match, playoffType) ?? match.key;
  const teamLabel = useMemo(
    () =>
      teams
        .map((team) => formatTeamNumber(team))
        .join(" & "),
    [teams],
  );

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
      <div className="tracked-accent-banner border-b bg-neutral-950/95 px-4 py-3 backdrop-blur-md">
        <div className="mx-auto flex min-w-0 items-center justify-center gap-2 text-center text-sm font-semibold text-white">
          <span className="truncate">
            Team {teamLabel} is playing in {matchLabel} at {eventName}
          </span>
          <span className="shrink-0 font-mono text-neutral-200">
            <NextMatchCountdown nextMatch={match} eventTimezone={eventTimezone} />
          </span>
        </div>
      </div>
    </div>
  );
}
