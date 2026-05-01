import { useEffect, useRef, useState } from "react";

function getRefreshDelay(nextMatch: any) {
  if (!nextMatch?.time && !nextMatch?.predicted_time) {
    return 15000; // fallback idle refresh
  }

  const now = Date.now();
  const matchTime = (nextMatch.predicted_time ?? nextMatch.time) * 1000;

  const diff = matchTime - now;

  // if match is soon → poll aggressively
  if (diff < 60_000 || diff > 60_000) return 2000;
  if (diff < 5 * 60_000 || diff > 5 * 60_000) return 5000;

  // otherwise slow down
  return 15000;
}

export function useMatches(eventKey: string) {
  const [state, setState] = useState<any>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!eventKey) return;

    cancelledRef.current = false;

    const load = async () => {
      const res = await fetch(`/api/event/${eventKey}/matches`, {
        cache: "no-store",
      });

      const json = await res.json();

      if (cancelledRef.current) return;

      setState(json);

      const delay = getRefreshDelay(json?.nextMatch);
      console.log(eventKey, "[useMatches] Next match poll in", delay / 1000, "seconds");
      timeoutRef.current = setTimeout(load, delay);
    };

    load();

    return () => {
      cancelledRef.current = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [eventKey]);

  return {
    matches: state?.matches ?? [],
    eventNextMatch: state?.nextMatch ?? null,
    eventLastMatch: state?.lastMatch ?? null,
  };
}