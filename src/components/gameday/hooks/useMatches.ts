import { useEffect, useState, useMemo, useCallback } from "react";

export function useMatches(eventKey: string) {
  const [matches, setMatches] = useState<any[]>([]);
  const REFRESH_MS = 10 * 1000;

  const load = useCallback(async () => {
    if (!eventKey) return;

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

  useEffect(() => {
    if (!eventKey) return;

    let cancelled = false;

    async function wrappedLoad() {
      if (cancelled) return;
      await load();
    }

    wrappedLoad();
    const intervalId = setInterval(wrappedLoad, REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [load, eventKey]);

  // PURE DERIVATIONS ONLY

  const eventNextMatch = useMemo(() => {
    return matches.find((m) => m.actual_time === null) || null;
  }, [matches]);

  const eventLastMatch = useMemo(() => {
    return (
      [...matches]
        .reverse()
        .find((m) => m.actual_time !== null) || null
    );
  }, [matches]);

  return {
    matches,
    eventNextMatch,
    eventLastMatch,
    reload: load, // ✅ now valid
  };
}