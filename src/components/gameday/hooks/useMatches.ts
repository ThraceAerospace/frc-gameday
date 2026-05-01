import next from "next";
import { useEffect, useRef, useState } from "react";

function getRefreshDelay(nextMatch: any) {
  if (!nextMatch?.time && !nextMatch?.predicted_time) {
    return 15000; // fallback idle refresh
  }

  const now = Date.now();
  const matchTime = (nextMatch.predicted_time ?? nextMatch.time) * 1000;

  const diff = matchTime - now;

  // if match is soon → poll aggressively
  if (diff < 60_000 ) return 2000;
  if (diff < 5 * 60_000) return 5000;

  // otherwise slow down
  return 30000;
}

export function useMatches(eventKey: string) {
  const [state, setState] = useState<any>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const allMatchesLoadedRef = useRef<NodeJS.Timeout | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!eventKey) return;

    cancelledRef.current = false;

    const fetchAllMatches = async () => {
      const res = await fetch(`/api/event/${eventKey}/matches`, {
        cache: "no-store",
      });
      const json = await res.json();

      if (cancelledRef.current) return;

      setState((prev: any) => ({
        ...prev,
        matches: json.matches,
      }));

      allMatchesLoadedRef.current = setTimeout(fetchAllMatches, 5 * 60 * 1000);
    };

    const fetchCurrentMatches = async () => {
      const [lastres, nextres] = await Promise.all([
        fetch(`/api/event/${eventKey}/matches/last`, { cache: "no-store" }),
        fetch(`/api/event/${eventKey}/matches/next`, { cache: "no-store" }),
      ]);

      const lastMatch = await lastres.json();
      const nextMatch = await nextres.json();

      if (cancelledRef.current) return;

      setState((prev: any) => ({
        matches: prev?.matches ?? [],
        nextMatch: nextMatch.nextMatch,
        lastMatch: lastMatch.lastMatch,
      }));

      const delay = getRefreshDelay(nextMatch.nextMatch);
      timeoutRef.current = setTimeout(fetchCurrentMatches, delay);
    };

    fetchAllMatches();
    fetchCurrentMatches();

    return () => {
      cancelledRef.current = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (allMatchesLoadedRef.current) clearTimeout(allMatchesLoadedRef.current);
    };
  }, [eventKey]);

  return {
    matches: state?.matches ?? [],
    eventNextMatch: state?.nextMatch ?? null,
    eventLastMatch: state?.lastMatch ?? null,
  };
}