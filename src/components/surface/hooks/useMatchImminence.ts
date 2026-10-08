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
  const imminentKeyRef = useRef<string | null>(null);

  useEffect(() => {
    emitRef.current = emit;
  }, [emit]);

  useEffect(() => {
    const eventKey = eventNextMatch?.key ?? null;
    const trackedNextMatchKeys = trackedTeams.map(
      (team) => teamsStatuses[team]?.next_match_key ?? null,
    );

    const nextImminentKey =
      enabled &&
      eventKey &&
      trackedNextMatchKeys.some((matchKey) => matchKey === eventKey)
        ? eventKey
        : null;

    const previousKey = imminentKeyRef.current;

    if (previousKey && previousKey !== nextImminentKey) {
      emitRef.current({
        type: "match_no_longer_imminent",
        eventKey: eventKey ?? "",
        matchKey: previousKey,
      });
    }

    if (nextImminentKey && previousKey !== nextImminentKey) {
      emitRef.current({
        type: "match_imminent",
        eventKey: eventKey,
        matchKey: nextImminentKey,
        severity: "hard",
      });
    }

    imminentKeyRef.current = nextImminentKey;
  }, [
    enabled,
    eventNextMatch?.key,
    trackedTeams,
    teamsStatuses,
  ]);

  useEffect(() => {
    return () => {
      const key = imminentKeyRef.current;

      if (key) {
        emitRef.current({
          type: "match_no_longer_imminent",
          eventKey: "",
          matchKey: key,
        });
      }

      imminentKeyRef.current = null;
    };
  }, []);
}
