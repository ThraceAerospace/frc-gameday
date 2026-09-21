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

  /*
   * Monotonically increasing client-side request ID.
   */
  const requestIdRef = useRef(0);

  /*
   * The most recently STARTED request.
   */
  const latestStartedRequestRef =
    useRef(0);

  /*
   * The most recently COMPLETED request.
   *
   * This is separate from latestStartedRequestRef because
   * an older request can finish after a newer request.
   */
  const latestCompletedRequestRef =
    useRef(0);

  /*
   * Track the request that most recently committed state.
   */
  const latestCommittedRequestRef =
    useRef(0);

  /*
   * Keep the current React state visible to callbacks/logging.
   */
  const matchesRef =
    useRef<TBAMatch[]>([]);

  /*
   * Every time the state setter is invoked we increment this.
   * This gives us a separate state-update sequence from the
   * network request sequence.
   */
  const stateUpdateIdRef =
    useRef(0);

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


        /*
         * Update our completion frontier before committing
         * this response.
         */
        if (
          requestId >
          latestCompletedRequestRef.current
        ) {
          latestCompletedRequestRef.current =
            requestId;
        }

        /*
         * Explicitly log whether this response is already
         * older than a request that started after it.
         */
        if (newerRequestStarted) {
          console.warn(
            "[useMatches] STALE RESPONSE DETECTED",
            {
              eventKey,
              requestId,
              latestStartedRequest:
                latestStartedRequestRef.current,
              summary,
            },
          );
        }

        /*
         * Record the exact state update operation.
         */
        const stateUpdateId =
          ++stateUpdateIdRef.current;

        console.log(
          "[useMatches] STATE SETTER",
          {
            eventKey,
            requestId,
            stateUpdateId,

            previousCommittedRequest:
              latestCommittedRequestRef.current,

            newerRequestStarted,

            summary,

            nextMatch:
              summarizeMatch(
                nextMatch,
              ),

            lastMatch:
              summarizeMatch(
                lastMatch,
              ),
          },
        );

        /*
         * Keep this behavior unchanged for now.
         *
         * We deliberately are NOT rejecting stale responses
         * yet because we want to observe exactly what happens
         * in production.
         */
        setMatches(sorted);

        latestCommittedRequestRef.current =
          requestId;

        console.log(
          "[useMatches] STATE SETTER COMPLETE",
          {
            eventKey,
            requestId,
            stateUpdateId,

            committedRequest:
              latestCommittedRequestRef.current,

            summary,
          },
        );
      } catch (error) {
        console.error(
          "[useMatches] REQUEST ERROR",
          {
            eventKey,
            requestId,

            durationMs: Math.round(
              performance.now() -
                startedAt,
            ),

            error,
          },
        );
      }
    },
    [eventKey],
  );

  /*
   * This effect runs after React has actually committed
   * a new `matches` value and the component has rendered
   * with that value.
   *
   * This is the important distinction between:
   *
   *   "setMatches was called"
   *
   * and:
   *
   *   "React actually committed the new matches state."
   */
  useEffect(() => {
    matchesRef.current =
      matches;

  }, [
    eventKey,
    matches,
  ]);

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