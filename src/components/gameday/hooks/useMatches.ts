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

  const latestStartedRequestRef = useRef(0);
  const latestCompletedRequestRef = useRef(0);
  const latestCommittedRequestRef = useRef(0);

  const matchesRef = useRef<TBAMatch[]>([]);

  const load = useCallback(
    async () => {
      if (!eventKey) {

        return;
      }

      const requestId =
        ++requestIdRef.current;

      latestStartedRequestRef.current =
        requestId;


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


        if (requestId > latestCompletedRequestRef.current) {
          latestCompletedRequestRef.current = requestId;
        }

        setMatches(sorted);

        latestCommittedRequestRef.current = requestId;
      } catch (error) {
        console.error("[useMatches] request failed", error);
      }
    },
    [eventKey],
  );

  useEffect(() => {
    matchesRef.current = matches;
  }, [matches]);

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

    matchesRef.current = [];

    latestStartedRequestRef.current =
      0;

    latestCompletedRequestRef.current =
      0;

    latestCommittedRequestRef.current =
      0;

    requestIdRef.current = 0;

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