import { useEffect, useState } from "react";

export function usePlayoffAlliances(eventKey:string) {
  const [alliances, setAlliances] = useState([]);

  useEffect(() => {
    if (!eventKey) return;

    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/event/${eventKey}/playoffs/alliances`);

        if (!res.ok) throw new Error("Alliances fetch failed");

        const json = await res.json();
        //console.log("[useMatches] Raw Matches", json)
        if (cancelled) return;

        setAlliances(json);
      } catch (err) {
        console.error("useAlliances error:", err);
        setAlliances([]);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [eventKey]);

  return { alliances:alliances };
}