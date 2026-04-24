import { useMemo } from "react";

/**
 * Normalize team keys from a match safely
 * Handles inconsistent API shapes:
 * - alliances.red.team_keys
 * - alliances.blue.team_keys
 * - or flat arrays
 */
function getMatchTeams(match: any): string[] {
  const red = match?.alliances?.red?.team_keys || [];
  const blue = match?.alliances?.blue?.team_keys || [];

  // fallback for alternate API shape
  const flat = match?.alliances?.flat || [];

  return [...red, ...blue, ...flat].filter(Boolean);
}

/**
 * Safe check: does match involve any tracked teams?
 */
function matchHasTrackedTeam(match: any, trackedTeams: string[]) {
  if (!trackedTeams?.length) return true;

  const teams = getMatchTeams(match);
  return teams.some((t) => trackedTeams.includes(t));
}

export function useTrackedEvent(matches: any[] = [], trackedTeams: string[] = []) {
  /**
   * Normalize input defensively
   */
  const safeMatches = useMemo(() => {
    if (!Array.isArray(matches)) return [];

    return matches;
  }, [matches]);

  /**
   * TRACKED MATCHES (view layer)
   * - multi-team safe
   * - preserves event order
   */
  const trackedMatches = useMemo(() => {
    if (!trackedTeams || trackedTeams.length === 0) {
      return safeMatches;
    }

    return safeMatches.filter((m) =>
      matchHasTrackedTeam(m, trackedTeams)
    );
  }, [safeMatches, trackedTeams]);

  /**
   * EVENT NEXT MATCH (global, unfiltered)
   */
  const eventNextMatch = useMemo(() => {
    return (
      safeMatches.find((m) => m.actual_time === null) || null
    );
  }, [safeMatches]);

  /**
   * EVENT LAST MATCH (global, unfiltered)
   */
  const eventLastMatch = useMemo(() => {
    return (
      [...safeMatches]
        .reverse()
        .find((m) => m.actual_time !== null) || null
    );
  }, [safeMatches]);

  /**
   * TRACKED NEXT MATCH
   */
  const trackedNextMatch = useMemo(() => {
    return (
      trackedMatches.find((m) => m.actual_time === null) || null
    );
  }, [trackedMatches]);

  /**
   * TRACKED LAST MATCH
   */
  const trackedLastMatch = useMemo(() => {
    return (
      [...trackedMatches]
        .reverse()
        .find((m) => m.actual_time !== null) || null
    );
  }, [trackedMatches]);

  /**
   * SORTED VIEW (optional convenience for MatchStrip)
   */
  const sortedTrackedMatches = useMemo(() => {
    return [...trackedMatches].sort(
      (a, b) => (a.predicted_time || 0) - (b.predicted_time || 0)
    );
  }, [trackedMatches]);

  return {
    // raw views
    trackedMatches: sortedTrackedMatches,

    // event-wide
    eventNextMatch,
    eventLastMatch,

    // team-scoped
    trackedNextMatch,
    trackedLastMatch,
  };
}