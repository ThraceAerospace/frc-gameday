"use client";

import { useCallback, useEffect, useRef } from "react";

export const POLLING_INTERVALS = {
  realtime: 1_000,
  fast: 5_000,
  intermediate: 3 * 60_000,
  long: 60 * 60_000,
} as const;

export type PollingTier = keyof typeof POLLING_INTERVALS;

export function usePolling(
  callback: () => void | Promise<void>,
  tier: PollingTier,
  options: {
    enabled?: boolean;
    resetKey?: string | null;
  } = {},
) {
  const {
    enabled = true,
    resetKey = null,
  } = options;

  const callbackRef = useRef(callback);
  const timerRef = useRef<number | null>(null);
  const generationRef = useRef(0);

  callbackRef.current = callback;

  const schedule = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;

      const generation =
        ++generationRef.current;

      Promise.resolve(
        callbackRef.current(),
      ).finally(() => {
        if (
          generation ===
          generationRef.current
        ) {
          schedule();
        }
      });
    }, POLLING_INTERVALS[tier]);
  }, [tier]);

  const reload = useCallback(async () => {
    /*
     * Invalidate any existing poll or reload.
     */
    const generation =
      ++generationRef.current;

    /*
     * Reset the fallback timer.
     */
    if (timerRef.current !== null) {
      window.clearTimeout(
        timerRef.current,
      );

      timerRef.current = null;
    }

    try {
      await callbackRef.current();
    } finally {
      /*
       * Only the newest request is allowed
       * to establish the next fallback window.
       */
      if (
        generation ===
        generationRef.current
      ) {
        schedule();
      }
    }
  }, [schedule]);

  useEffect(() => {
    if (!enabled) return;

    void reload();

    return () => {
      generationRef.current++;

      if (timerRef.current !== null) {
        window.clearTimeout(
          timerRef.current,
        );

        timerRef.current = null;
      }
    };
  }, [
    enabled,
    resetKey,
    reload,
  ]);

  return reload;
}