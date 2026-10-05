"use client";

import type { TBAEliminationAlliance, TBAMatch } from "@/lib/tba/types";
import { useEffect, useRef } from "react";
import MatchCard from "./MatchCard";

export default function MatchStrip({
  matches = [],
  eventTimezone,
  team = [],
  nextMatch,
  lastMatch,
  playoffAlliances = [],
  playoffType = null,
  multiview = {},
}: {
  matches?: TBAMatch[];
  team?: string[];
  nextMatch?: TBAMatch | null;
  lastMatch?: TBAMatch | null;
  eventTimezone?: string | null;
  playoffAlliances?: TBAEliminationAlliance[];
  playoffType?: number | null;
  multiview?: Record<string, unknown>;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /*
   * Keep every match in the strip while avoiding duplicate keys.
   *
   * lastMatch / nextMatch are included as fallbacks in case they
   * have not yet appeared in the main match data.
   */
  const seen = new Set();
  const cards = [];

  for (const match of [
    ...matches,
    lastMatch,
    nextMatch,
  ]) {
    if (
      !match?.key ||
      seen.has(match.key)
    ) {
      continue;
    }

    seen.add(match.key);
    cards.push(match);
  }

  const presentation =
    (multiview?.presentation as
      | { matchInfo?: string }
      | undefined) ?? {};

  const hideMatchCards =
    presentation.matchInfo === "hidden";
  /*
   * Automatically bring the next match into view whenever the
   * actual next match changes.
   *
   * The data refreshes may cause this component to render many
   * times, so the dependency is specifically nextMatch?.key.
   */
useEffect(() => {
  if (
    hideMatchCards ||
    !nextMatch?.key ||
    !scrollRef.current
  ) {
    return;
  }

  const nextElement =
    scrollRef.current.querySelector(
      `[data-match-key="${CSS.escape(nextMatch.key)}"]`,
    ) as HTMLElement | null;

  if (!nextElement) {
    return;
  }

  const container = scrollRef.current;

  const targetLeft =
    nextElement.offsetLeft -
    nextElement.offsetWidth -
    8;

  container.scrollTo({
    left: Math.max(0, targetLeft),
    behavior: "smooth",
  });
}, [nextMatch?.key, hideMatchCards]);

  return (
    <div className="relative border-t border-l border-white/10 bg-neutral-950/95">


      {!hideMatchCards && (
        <div
          ref={scrollRef}
          className="h-[52px] overflow-x-auto overflow-y-hidden no-scrollbar"
        >
          {cards.length > 0 ? (
            <div className="flex h-full min-w-max items-center gap-1.5 px-2">
              {cards.map((match) => (
                <div
                  key={match.key}
                  data-match-key={match.key}
                  className="shrink-0"
                >
                  <MatchCard
                    match={match}
                    team={team}
                    isNext={
                      match.key ===
                      nextMatch?.key
                    }
                    isLast={
                      match.key ===
                      lastMatch?.key
                    }
                    playoffAlliances={
                      playoffAlliances
                    }
                    playoffType={
                      playoffType
                    }
                    eventTimezone={
                      eventTimezone ?? undefined
                    }
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-full items-center px-3 text-[10px] text-neutral-600">
              No match data available
            </div>
          )}
        </div>
      )}
    </div>
  );
}