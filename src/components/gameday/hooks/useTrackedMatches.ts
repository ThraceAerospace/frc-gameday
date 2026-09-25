"use client";

import { useMemo } from "react";
import type { TBAMatch } from "@/lib/tba/types";
import { getLastMatch, getMatchesForTeams, getNextMatch } from "@/lib/gameday/matchUtils";

export function useTrackedMatches(matches: TBAMatch[], trackedTeams: string[]) {
  const trackedMatches = useMemo(() => getMatchesForTeams(matches, trackedTeams), [matches, trackedTeams]);
  const trackedNextMatch = useMemo(() => getNextMatch(trackedMatches), [trackedMatches]);
  const trackedLastMatch = useMemo(() => getLastMatch(trackedMatches), [trackedMatches]);
  const trackedNextMatches = useMemo(() => {
    const result: Record<string, TBAMatch | null> = {};
    for (const team of trackedTeams) {
      result[team] = getNextMatch(getMatchesForTeams(matches, [team]));
    }
    return result;
  }, [matches, trackedTeams]);
  return { trackedMatches, trackedNextMatch, trackedLastMatch, trackedNextMatches };
}
