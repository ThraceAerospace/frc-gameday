import { useEffect, useMemo, useState } from "react";

export function useMatches(eventKey: string) {
  const [matches, setMatches] = useState([]);

  useEffect(() => {
    if (!eventKey) return;

    async function load() {
      const res = await fetch(`/api/event/${eventKey}/matches`);
      const json = await res.json();

      setMatches(
        (json || []).sort(
          (a:any, b:any) => (a.predicted_time || 0) - (b.predicted_time || 0)
        )
      );
    }

    load();
  }, [eventKey]);

  return { matches };
}