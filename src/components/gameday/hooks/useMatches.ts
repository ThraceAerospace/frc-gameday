import { useEffect, useState, useMemo } from "react";

export function useMatches(eventKey: string) {
  const [matches, setMatches] = useState<any[]>([]);

  useEffect(() => {
    if (!eventKey) return;

    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/event/${eventKey}/matches`);
        if (!res.ok) throw new Error("Matches fetch failed");

        const json = await res.json();

        if (cancelled) return;

        const sorted = (json || []).sort(
          (a: any, b: any) =>
            (a.predicted_time || 0) - (b.predicted_time || 0)
        );

        setMatches(sorted);
      } catch (err) {
        console.error("useMatches error:", err);
        setMatches([]);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [eventKey]);

  // PURE DERIVATIONS ONLY (no team logic, no filtering)

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
  };
}