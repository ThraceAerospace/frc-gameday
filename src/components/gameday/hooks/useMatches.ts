"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  getLastMatch,
  getNextMatch,
  sortMatches,
} from "@/lib/gameday/matchUtils";
import type { TBAMatch } from "@/lib/tba/types";
import { usePolling } from "./usePolling";

export function useMatches(
  eventKey: string,
) {
  const [matches, setMatches] =
    useState<TBAMatch[]>([]);

  const load = useCallback(
    async () => {
      if (!eventKey) return;

      try {
        const res = await fetch(
          `/api/event/${eventKey}/matches`,
          {
            cache: "no-store",
          },
        );

        if (!res.ok) {
          throw new Error(
            `HTTP ${res.status}`,
          );
        }

        const data =
          (await res.json()) as TBAMatch[];

        setMatches(
          Array.isArray(data)
            ? sortMatches(data)
            : [],
        );
      } catch (error) {
        console.error(
          "useMatches:",
          error,
        );
      }
    },
    [eventKey],
  );

  const reload = usePolling(
    load,
    "intermediate",
    {
      enabled: Boolean(eventKey),
      resetKey: eventKey,
    },
  );

  useEffect(() => {
    setMatches([]);
  }, [eventKey]);

  const eventNextMatch = useMemo(
    () => getNextMatch(matches),
    [matches],
  );

  const eventLastMatch = useMemo(
    () => getLastMatch(matches),
    [matches],
  );

  return {
    matches,
    eventNextMatch,
    eventLastMatch,
    reload,
  };
}