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

function summarizeMatch(
  match: TBAMatch | null | undefined,
) {
  if (!match) {
    return null;
  }

  return {
    key: match.key,
    comp_level: match.comp_level,
    set_number: match.set_number,
    match_number: match.match_number,
    time: match.time,
    predicted_time: match.predicted_time,
    actual_time: match.actual_time,
    winning_alliance: match.winning_alliance,
    red_score: match.alliances.red.score,
    blue_score: match.alliances.blue.score,
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

    firstMatch:
      matches.length > 0
        ? summarizeMatch(matches[0])
        : null,

    lastMatchInArray:
      matches.length > 0
        ? summarizeMatch(
            matches[matches.length - 1],
          )
        : null,

    lastPlayed:
      played.length > 0
        ? summarizeMatch(
            played[played.length - 1],
          )
        : null,

    firstUnplayed:
      unplayed.length > 0
        ? summarizeMatch(unplayed[0])
        : null,

    boundary: matches
      .slice(
        Math.max(
          0,
          played.length - 3,
        ),
        played.length + 4,
      )
      .map(summarizeMatch),

    /*
     * Keep the complete match keys available in the log.
     * This makes it possible to tell whether the response
     * actually contains the current competition frontier.
     */
    keys: matches.map(
      (match) => match.key,
    ),
  };
}

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
        console.log(
          "[useMatches] LOAD SKIPPED",
          {
            eventKey,
            reason: "empty eventKey",
          },
        );

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

          /*
           * Snapshot of the state that existed when this
           * request started.
           */
          previousState: {
            count: matchesRef.current.length,
            summary:
              summarizeMatches(
                matchesRef.current,
              ),
          },
        },
      );

      try {
        const url =
          `/api/event/${eventKey}/matches`;

        const res = await fetch(
          url,
          {
            cache: "no-store",
          },
        );

        const responseAt =
          performance.now();

        const responseTimestamp =
          new Date().toISOString();

        const responseHeaders = {
          cacheControl:
            res.headers.get(
              "cache-control",
            ),
          etag:
            res.headers.get("etag"),
          age:
            res.headers.get("age"),
          date:
            res.headers.get("date"),
          contentType:
            res.headers.get(
              "content-type",
            ),
        };

        if (!res.ok) {
          throw new Error(
            `HTTP ${res.status}`,
          );
        }

        const data =
          (await res.json()) as TBAMatch[];

        const jsonParsedAt =
          performance.now();

        const sorted =
          Array.isArray(data)
            ? sortMatches(data)
            : [];

        const latestStartedRequest =
          latestStartedRequestRef.current;

        const latestCompletedRequest =
          latestCompletedRequestRef.current;

        const newerRequestStarted =
          latestStartedRequest >
          requestId;

        const newerRequestCompleted =
          latestCompletedRequest >
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

            url,

            durationMs: Math.round(
              responseAt -
                startedAt,
            ),

            jsonParseMs: Math.round(
              jsonParsedAt -
                responseAt,
            ),

            startedTimestamp,

            responseTimestamp,

            responseHeaders,

            responseArray: {
              isArray:
                Array.isArray(data),

              length:
                Array.isArray(data)
                  ? data.length
                  : null,
            },

            requestOrdering: {
              latestStartedRequest,
              latestCompletedRequest,
              newerRequestStarted,
              newerRequestCompleted,
            },

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

    const summary =
      summarizeMatches(matches);

    const nextMatch =
      getNextMatch(matches);

    const lastMatch =
      getLastMatch(matches);

    console.log(
      "[useMatches] STATE COMMITTED",
      {
        eventKey,

        stateCount:
          matches.length,

        latestCommittedRequest:
          latestCommittedRequestRef.current,

        latestStartedRequest:
          latestStartedRequestRef.current,

        latestCompletedRequest:
          latestCompletedRequestRef.current,

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
    console.log(
      "[useMatches] EVENT KEY RESET",
      {
        eventKey,
      },
    );

    setMatches([]);

    matchesRef.current = [];

    latestStartedRequestRef.current =
      0;

    latestCompletedRequestRef.current =
      0;

    latestCommittedRequestRef.current =
      0;

    requestIdRef.current = 0;

    stateUpdateIdRef.current = 0;
  }, [eventKey]);

  const eventNextMatch = useMemo(
    () => getNextMatch(matches),
    [matches],
  );

  const eventLastMatch = useMemo(
    () => getLastMatch(matches),
    [matches],
  );

  /*
   * Log the derived values separately.
   *
   * This tells us whether the hook itself is deriving
   * something different from what the committed state
   * contains.
   */
  useEffect(() => {
    console.log(
      "[useMatches] DERIVED VALUES",
      {
        eventKey,

        matchesCount:
          matches.length,

        eventNextMatch:
          summarizeMatch(
            eventNextMatch,
          ),

        eventLastMatch:
          summarizeMatch(
            eventLastMatch,
          ),
      },
    );
  }, [
    eventKey,
    matches,
    eventNextMatch,
    eventLastMatch,
  ]);

  return {
    matches,
    eventNextMatch,
    eventLastMatch,
    reload,
  };
}