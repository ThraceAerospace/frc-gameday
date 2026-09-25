"use client";

import { useCallback, useEffect, useState } from "react";
import type { TBAEliminationAlliance } from "@/lib/tba/types";
import { usePolling } from "./usePolling";

export function usePlayoffAlliances(eventKey: string) {
  const [alliances, setAlliances] = useState<TBAEliminationAlliance[]>([]);
  const load = useCallback(async () => {
    if (!eventKey) return;
    try {
      const res = await fetch(`/api/event/${eventKey}/playoffs/alliances`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as TBAEliminationAlliance[];
      setAlliances(Array.isArray(data) ? data : []);
    } catch (error) { console.error("usePlayoffAlliances:", error); }
  }, [eventKey]);
  const reload = usePolling(load, "long", { enabled: Boolean(eventKey), resetKey: eventKey });
  useEffect(() => setAlliances([]), [eventKey]);
  return { alliances, reload };
}
