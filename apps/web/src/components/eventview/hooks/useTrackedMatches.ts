"use client";

import { useMemo } from "react";
import type { FieldViewMatch } from "@fieldview/domain";
import { getLastMatch, getMatchesForTeams, getNextMatch } from "@/lib/tba/matchUtils";

export function useTrackedMatches(matches: FieldViewMatch[], trackedTeams: string[]) {
  const trackedMatches = useMemo(() => getMatchesForTeams(matches, trackedTeams), [matches, trackedTeams]);
  const trackedNextMatch = useMemo(() => getNextMatch(trackedMatches), [trackedMatches]);
  const trackedLastMatch = useMemo(() => getLastMatch(trackedMatches), [trackedMatches]);
  const trackedNextMatches = useMemo(() => {
    const result: Record<string, FieldViewMatch | null> = {};
    for (const team of trackedTeams) {
      result[team] = getNextMatch(getMatchesForTeams(matches, [team]));
    }
    return result;
  }, [matches, trackedTeams]);
  return { trackedMatches, trackedNextMatch, trackedLastMatch, trackedNextMatches };
}
