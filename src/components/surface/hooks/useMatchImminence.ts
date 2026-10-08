"use client";

import { useEffect, useRef } from "react";
import type { TBAMatch, TBAEventTeamStatuses } from "@/lib/tba/types";

export type MatchImminenceSignal =
  | {
      type: "match_imminent";
      eventKey: string;
      matchKey: string;
      severity: "hard" | "soft";
    }
  | {
      type: "match_no_longer_imminent";
      eventKey: string;
      matchKey: string;
    };

/**
 * A match is imminent when it is both:
 * - the event's next unscored match, and
 * - the next match reported by TBA for at least one tracked team.
 *
 * TBA's team-event status is authoritative for the team's next match.
 */
export function useMatchImminence(
  eventNextMatch: TBAMatch | null,
  trackedTeams: string[],
  teamsStatuses: TBAEventTeamStatuses,
  enabled: boolean,
  emit: (signal: MatchImminenceSignal) => void,
) {
  const emitRef = useRef(emit);
  const imminentRef = useRef<{
    eventKey: string;
    matchKey: string;
  } | null>(null);

  useEffect(() => {
    emitRef.current = emit;
  }, [emit]);

  useEffect(() => {
    const eventKey = eventNextMatch?.key ?? null;
    const trackedNextMatchKeys = trackedTeams.map(
      (team) => teamsStatuses[team]?.next_match_key ?? null,
    );

    const nextImminent =
      enabled &&
      eventKey !== null &&
      trackedNextMatchKeys.some((matchKey) => matchKey === eventKey)
        ? { eventKey, matchKey: eventKey }
        : null;

    const previous = imminentRef.current;
    const hasChanged =
      previous &&
      (previous.eventKey !== nextImminent?.eventKey ||
        previous.matchKey !== nextImminent?.matchKey);

    if (previous && hasChanged) {
      emitRef.current({
        type: "match_no_longer_imminent",
        eventKey: previous.eventKey,
        matchKey: previous.matchKey,
      });
    }

    if (nextImminent && hasChanged) {
      emitRef.current({
        type: "match_imminent",
        eventKey: nextImminent.eventKey,
        matchKey: nextImminent.matchKey,
        severity: "hard",
      });
    }

    imminentRef.current = nextImminent;
  }, [
    enabled,
    eventNextMatch?.key,
    trackedTeams,
    teamsStatuses,
  ]);

  useEffect(() => {
    return () => {
      const imminent = imminentRef.current;

      if (imminent) {
        emitRef.current({
          type: "match_no_longer_imminent",
          eventKey: imminent.eventKey,
          matchKey: imminent.matchKey,
        });
      }

      imminentRef.current = null;
    };
  }, []);
}
