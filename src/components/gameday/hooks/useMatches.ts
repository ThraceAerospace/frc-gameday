"use client";

import { useEffect, useRef, useState, useMemo } from "react";

/**
 * Refresh logic based on next match timing
 */
function getRefreshDelay(nextMatch: any) {
  if (!nextMatch?.time && !nextMatch?.predicted_time) {
    return 15000;
  }

  const now = Date.now();
  const matchTime = nextMatch.predicted_time * 1000; // strict: no fallback
  const diff = matchTime - now;

  if (diff < 60_000) return 2000;
  if (diff < 5 * 60_000) return 5000;
  return 30000;
}

/**
 * Strict match comparison (only what actually matters for identity changes)
 */
function isSameMatch(a: any, b: any) {
  if (!a || !b) return false;

  return (
    a.match_key === b.match_key &&
    a.actual_time === b.actual_time &&
    a.predicted_time === b.predicted_time
  );
}

/**
 * Extract teams from match safely
 */
function getMatchTeams(match: any): string[] {
  const red = match?.alliances?.red?.team_keys || [];
  const blue = match?.alliances?.blue?.team_keys || [];
  const flat = match?.alliances?.flat || [];

  return [...red, ...blue, ...flat].filter(Boolean);
}

export function useMatches(eventKey: string, trackedTeams: string[] = []) {
  const [state, setState] = useState<any>({
    matches: [],
    nextMatch: null,
  });

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const rebuildRef = useRef<NodeJS.Timeout | null>(null);

  const cancelledRef = useRef(false);
  const prevNextRef = useRef<any>(null);

  useEffect(() => {
    if (!eventKey) return;

    cancelledRef.current = false;

    /**
     * FULL REBUILD (source of truth)
     * NOTE: predicted_time is the ONLY ordering key
     */
    const fetchAllMatches = async () => {
      console.log(`[useMatches] FULL REBUILD for ${eventKey}`);

      const res = await fetch(`/api/event/${eventKey}/matches`, {
        cache: "no-store",
      });

      const json = await res.json();
      if (cancelledRef.current) return;

      const matches = json.matches ?? [];

      const sorted = [...matches].sort((a: any, b: any) => {
        // STRICT RULE: predicted_time only
        return a.predicted_time - b.predicted_time;
      });

      setState({
        matches: sorted,
        nextMatch: json.nextMatch ?? null,
      });
    };

    /**
     * NEXT MATCH FAST POLL
     */
    const fetchNextMatch = async () => {
      const res = await fetch(`/api/event/${eventKey}/matches/next`, {
        cache: "no-store",
      });

      const json = await res.json();
      if (cancelledRef.current) return;

      const nextMatch = json.nextMatch;

      const changed = !isSameMatch(prevNextRef.current, nextMatch);
      prevNextRef.current = nextMatch;

      setState((prev: any) => ({
        ...prev,
        nextMatch,
      }));

      if (changed) {
        console.log("[useMatches] Next match changed → full rebuild");
        fetchAllMatches();
      }

      const delay = getRefreshDelay(nextMatch);
      timeoutRef.current = setTimeout(fetchNextMatch, delay);
    };

    /**
     * SAFETY REBUILD LOOP (prevents drift)
     */
    const scheduleRebuild = () => {
      rebuildRef.current = setTimeout(async () => {
        await fetchAllMatches();
        if (!cancelledRef.current) scheduleRebuild();
      }, 3 * 60 * 1000);
    };

    /**
     * INIT
     */
    fetchAllMatches();
    fetchNextMatch();
    scheduleRebuild();

    /**
     * CLEANUP
     */
    return () => {
      cancelledRef.current = true;

      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (rebuildRef.current) clearTimeout(rebuildRef.current);
    };
  }, [eventKey]);

  /**
   * =========================
   * DERIVED STATE
   * =========================
   */

  const matches = state.matches;
  const eventNextMatch = state.nextMatch;

  const eventLastMatch = useMemo(() => {
    // last completed match (pure derived, no API trust needed)
    let last = null;

    for (const m of matches) {
      if (m.actual_time != null) {
        if (!last || m.actual_time > last.actual_time) {
          last = m;
        }
      }
    }

    return last;
  }, [matches]);

  const trackedMatches = useMemo(() => {
    if (!trackedTeams?.length) return matches;

    return matches.filter((m: any) => {
      const teams = getMatchTeams(m);
      return teams.some((t) => trackedTeams.includes(t));
    });
  }, [matches, trackedTeams]);

  const trackedNextMatch = useMemo(() => {
    if (!trackedTeams?.length) return eventNextMatch;

    return trackedMatches.find((m: any) => m.actual_time === null) || null;
  }, [trackedMatches, trackedTeams, eventNextMatch]);

  const trackedLastMatch = useMemo(() => {
    if (!trackedTeams?.length) return eventLastMatch;

    let last = null;

    for (const m of trackedMatches) {
      if (m.actual_time != null) {
        if (!last || m.actual_time > last.actual_time) {
          last = m;
        }
      }
    }

    return last;
  }, [trackedMatches, eventLastMatch]);

  return {
    matches,

    eventNextMatch,
    eventLastMatch,

    trackedMatches,
    trackedNextMatch,
    trackedLastMatch,
  };
}