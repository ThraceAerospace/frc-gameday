import { useEffect, useState, useMemo, useCallback, useRef } from "react";

function getAdaptiveInterval(nextMatch?: any) {
  const now = Date.now() / 1000;

  if (!nextMatch?.predicted_time) {
    return 180_000; // 3 min fallback
  }

  const secondsUntilMatch = nextMatch.predicted_time - now;

  if (secondsUntilMatch < 120) {
    return 10_000; // 10s (very live)
  }

  if (secondsUntilMatch < 300) {
    return 30_000; // 30s (approaching)
  }

  return 180_000; // 3 min (idle)
}

export function useMatches(eventKey: string) {
  const [matches, setMatches] = useState<any[]>([]);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    if (!eventKey || cancelledRef.current) return;

    try {
      const res = await fetch(`/api/event/${eventKey}/matches`);
      if (!res.ok) throw new Error("Matches fetch failed");

      const json = await res.json();

      const sorted = (json || []).sort(
        (a: any, b: any) =>
          (a.predicted_time || 0) - (b.predicted_time || 0)
      );

      setMatches(sorted);
    } catch (err) {
      console.error("useMatches error:", err);
      setMatches([]);
    }
  }, [eventKey]);

  const scheduleNext = useCallback((latestMatches: any[]) => {
    if (cancelledRef.current) return;

    const nextMatch =
      latestMatches.find((m) => m.actual_time === null) || null;

    const delay = getAdaptiveInterval(nextMatch);

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(async () => {
      await load();
      scheduleNext(latestMatches);
    }, delay);

    console.log(eventKey, "[useMatches] Next match refresh in:", delay);
  }, [load]);

  useEffect(() => {
    cancelledRef.current = false;

    const init = async () => {
      await load();

      setMatches((prev) => {
        scheduleNext(prev);
        return prev;
      });
    };

    init();

    return () => {
      cancelledRef.current = true;

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [load, scheduleNext]);

  /* -------------------------- */
  /* PURE DERIVATIONS           */
  /* -------------------------- */

  const eventNextMatch = useMemo(() => {
    return matches.find((m) => m.actual_time === null) || null;
  }, [matches]);

  const eventLastMatch = useMemo(() => {
    return [...matches]
      .reverse()
      .find((m) => m.actual_time !== null) || null;
  }, [matches]);

  return {
    matches,
    eventNextMatch,
    eventLastMatch,
    reload: load,
  };
}