"use client";

import { useMemo } from "react";

export function useTracking(matches: any[], tracked: string[] = []) {
  const trackedMatches = useMemo(() => {
    if (!tracked.length) return matches;

    return matches.filter((m) =>
      tracked.some((t) =>
        m.alliances.red.team_keys.includes(t) ||
        m.alliances.blue.team_keys.includes(t)
      )
    );
  }, [matches, tracked]);

  const nextTrackedMatch = useMemo(() => {
    return (
      trackedMatches.find((m) => m.actual_time === null) ?? null
    );
  }, [trackedMatches]);

  const lastTrackedMatch = useMemo(() => {
    return (
      [...trackedMatches]
        .filter((m) => m.actual_time !== null)
        .sort((a, b) => (b.actual_time ?? 0) - (a.actual_time ?? 0))[0] ?? null
    );
  }, [trackedMatches]);

  return {
    trackedMatches,
    nextTrackedMatch,
    lastTrackedMatch,
  };
}