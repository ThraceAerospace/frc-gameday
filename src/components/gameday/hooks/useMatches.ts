import { useEffect, useState } from "react";

export function useMatches(eventKey: string) {
  const [state, setState] = useState<any>(null);

  useEffect(() => {
    if (!eventKey) return;

    let cancelled = false;

    const load = async () => {
      const res = await fetch(`/api/event/${eventKey}/matches`, {
        cache: "no-store",
      });

      const json = await res.json();

      if (!cancelled) {
        setState(json);
      }
    };

    load();

    const interval = setInterval(load, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [eventKey]);

  return {
    matches: state?.matches ?? [],
    eventNextMatch: state?.nextMatch ?? null,
    eventLastMatch: state?.lastMatch ?? null,
  };
}