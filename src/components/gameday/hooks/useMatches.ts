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

function summarizeMatch(match: TBAMatch) {
  return {
    key: match.key,
    time: match.time,
    predicted_time: match.predicted_time,
    actual_time: match.actual_time,
  };
}

function summarizeMatches(
  matches: TBAMatch[],
) {
  const played = matches.filter(
    (match) => Boolean(match.actual_time),
  );

  const unplayed = matches.filter(
    (match) => !match.actual_time,
  );

  return {
    total: matches.length,

    playedCount: played.length,
    unplayedCount: unplayed.length,

    /*
     * These are deliberately derived from the response
     * itself rather than from a hard-coded match number.
     */
    lastPlayed: played.length
      ? summarizeMatch(
          played[played.length - 1],
        )
      : null,

    firstUnplayed: unplayed.length
      ? summarizeMatch(unplayed[0])
      : null,

    /*
     * Small window around the played/unplayed boundary.
     * This is much more useful than dumping the entire
     * match array while the event is live.
     */
    boundary: matches
      .slice(
        Math.max(
          0,
          played.length - 2,
        ),
        played.length + 3,
      )
      .map(summarizeMatch),
  };
}

export function useMatches(
  eventKey: string,
) {
  const [matches, setMatches] =
    useState<TBAMatch[]>([]);

  /*
   * Every load gets a monotonically increasing ID.
   */
  const requestIdRef = useRef(0);

  /*
   * Tracks the most recently STARTED request.
   *
   * This is intentionally different from requestIdRef:
   * when an old request finishes, we can tell whether
   * something newer was already in flight.
   */
  const latestStartedRequestRef =
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

      const startedAt =
        performance.now();

      const startedTimestamp =
        new Date().toISOString();

      console.log(
        "[useMatches] REQUEST START",
        {
          eventKey,
          requestId,
          startedTimestamp,
        },
      );

      try {
        const res = await fetch(
          `/api/event/${eventKey}/matches`,
          {
            cache: "no-store",
          },
        );

        const responseAt =
          performance.now();

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

        const latestStartedRequest =
          latestStartedRequestRef.current;

        const newerRequestStarted =
          latestStartedRequest >
          requestId;

        const summary =
          summarizeMatches(sorted);

        const nextMatch =
          getNextMatch(sorted);

        const lastMatch =
          getLastMatch(sorted);

        console.log(
          "[useMatches] RESPONSE",
          {
            eventKey,
            requestId,

            durationMs: Math.round(
              responseAt -
                startedAt,
            ),

            responseTimestamp:
              new Date().toISOString(),

            newerRequestStarted,

            latestStartedRequest,

            summary,

            nextMatch:
              nextMatch
                ? summarizeMatch(
                    nextMatch,
                  )
                : null,

            lastMatch:
              lastMatch
                ? summarizeMatch(
                    lastMatch,
                  )
                : null,
          },
        );

        /*
         * Important:
         *
         * Do NOT reject stale responses yet.
         *
         * We want to see whether an older response is
         * actually arriving after a newer response and
         * overwriting it.
         */
        setMatches(sorted);

        console.log(
          "[useMatches] STATE UPDATE",
          {
            eventKey,
            requestId,
            newerRequestStarted,
            matchSummary: summary,
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