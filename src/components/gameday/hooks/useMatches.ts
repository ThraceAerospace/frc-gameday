"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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

  const requestIdRef = useRef(0);
  const currentEventKeyRef = useRef(eventKey);

  currentEventKeyRef.current = eventKey;

  const load = useCallback(
    async () => {
      if (!eventKey) {
        return;
      }

      const requestId =
        ++requestIdRef.current;

      try {
        const url =
          `/api/event/${eventKey}/matches`;

        const res = await fetch(
          url,
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

        const sorted =
          Array.isArray(data)
            ? sortMatches(data)
            : [];

        if (
          currentEventKeyRef.current !== eventKey ||
          requestId !== requestIdRef.current
        ) {
          return;
        }

        setMatches(sorted);
      } catch (error) {
        console.error("[useMatches] request failed", error);
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
