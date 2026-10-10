"use client";

import type { TBAEliminationAlliance, TBAMatch } from "@/lib/tba/types";
import { useEffect, useRef } from "react";
import { hasPostedScore } from "@/lib/tba/matchUtils";
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
   * Keep the upcoming match at the left edge of the visible match bar.
   * Use viewport-relative geometry rather than offsetLeft: the card is
   * nested inside the flex content row, so offsetLeft can be relative to
   * that row instead of the scrolling container.
   *
   * Fall back to the furthest scored match when there is no next match,
   * so the strip still follows completed match data after an event ends.
   */
  const furthestScoredMatch = [...cards]
    .reverse()
    .find(hasPostedScore);
  const scrollTarget = nextMatch ?? furthestScoredMatch;

  useEffect(() => {
    const container = scrollRef.current;

    if (hideMatchCards || !scrollTarget?.key || !container) {
      return;
    }

    const targetElement = container.querySelector<HTMLElement>(
      '[data-match-key="' + scrollTarget.key + '"]',
    );

    if (!targetElement) {
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();
    const targetLeft =
      container.scrollLeft + targetRect.left - containerRect.left;

    container.scrollTo({
      left: Math.max(0, targetLeft - 8),
      behavior: "smooth",
    });
  }, [scrollTarget?.key, hideMatchCards]);

  return (
    <div className="relative border-l border-t border-white/10 bg-neutral-950/95">
      {!hideMatchCards && (
        <div
          ref={scrollRef}
          className="h-[52px] overflow-x-auto overflow-y-hidden no-scrollbar"
        >
          {cards.length > 0 ? (
            <div className="flex h-full min-w-max items-center gap-1.5 px-2">
              {cards.map((match) => (
                <MatchCard
                  key={match.key}
                    match={match}
                    team={team}
                    isNext={match.key === nextMatch?.key}
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