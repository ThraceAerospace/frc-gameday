"use client";

import { useCallback, useEffect, useState } from "react";
import type { TBAEventRanking } from "@/lib/tba/types";
import { usePolling } from "./usePolling";

export function useEventRankings(eventKey: string) {
  const [rankings, setRankings] = useState<TBAEventRanking | null>(null);

  const load = useCallback(async () => {
    if (!eventKey) return;

    try {
      const response = await fetch(
        `/api/event/${eventKey}/rankings`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as TBAEventRanking | null;
      setRankings(data);
    } catch (error) {
      console.error("useEventRankings:", error);
    }
  }, [eventKey]);

  const reload = usePolling(load, "intermediate", {
    enabled: Boolean(eventKey),
    resetKey: eventKey,
  });

  useEffect(() => {
    setRankings(null);
  }, [eventKey]);

  return {
    rankings,
    reload,
  };
}
