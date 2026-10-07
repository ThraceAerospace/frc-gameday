"use client";

import { useEffect, useRef } from "react";
import type { TBAMatch } from "@/lib/tba/types";

export type MatchImminenceSignal =
  | {
      type: "match_imminent";
      matchKey: string;
      severity: "hard" | "soft";
    }
  | {
      type: "match_no_longer_imminent";
      matchKey: string;
    };

/**
 * A tracked match is imminent when it is both:
 * - the event's next unscored match, and
 * - the next unscored match for at least one tracked team.
 *
 * The transition out of imminence is emitted when the match is no longer
 * the event/tracker's next match, normally because its score was posted.
 */
export function useMatchImminence(
  eventNextMatch: TBAMatch | null,
  trackedNextMatch: TBAMatch | null,
  enabled: boolean,
  emit: (signal: MatchImminenceSignal) => void,
) {
  const emitRef = useRef(emit);
  const imminentKeyRef = useRef<string | null>(null);

  useEffect(() => {
    emitRef.current = emit;
  }, [emit]);

  useEffect(() => {
    const eventKey = eventNextMatch?.key ?? null;
    const trackedKey = trackedNextMatch?.key ?? null;
    const nextImminentKey =
      enabled && eventKey && trackedKey && eventKey === trackedKey
        ? eventKey
        : null;

    const previousKey = imminentKeyRef.current;

    if (previousKey && previousKey !== nextImminentKey) {
      emitRef.current({
        type: "match_no_longer_imminent",
        matchKey: previousKey,
      });
    }

    if (nextImminentKey && previousKey !== nextImminentKey) {
      emitRef.current({
        type: "match_imminent",
        matchKey: nextImminentKey,
        severity: "hard",
      });
    }

    imminentKeyRef.current = nextImminentKey;
  }, [
    enabled,
    eventNextMatch?.key,
    trackedNextMatch?.key,
  ]);

  useEffect(() => {
    return () => {
      const key = imminentKeyRef.current;

      if (key) {
        emitRef.current({
          type: "match_no_longer_imminent",
          matchKey: key,
        });
      }

      imminentKeyRef.current = null;
    };
  }, []);
}
