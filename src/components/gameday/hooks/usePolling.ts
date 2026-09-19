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
  const { enabled = true, resetKey = null } = options;

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
      void poll();
    }, POLLING_INTERVALS[tier]);
  }, [tier]);

  /*
   * Fallback poll.
   *
   * A normal poll only runs when the polling timer fires.
   * Its completion establishes the next fallback window.
   */
  const poll = useCallback(async () => {
    const generation = ++generationRef.current;

    try {
      await callbackRef.current();
    } finally {
      /*
       * If a WSS reload happened while this request was running,
       * generationRef.current will have changed. In that case,
       * this obsolete poll must not schedule another poll.
       */
      if (generation === generationRef.current) {
        schedule();
      }
    }
  }, [schedule]);

  /*
   * WSS-priority reload.
   *
   * This always starts immediately, even if a fallback poll is
   * already running. The existing poll becomes obsolete.
   */
  const reload = useCallback(async () => {
    /*
     * Invalidate any currently-running fallback request.
     */
    generationRef.current++;

    /*
     * The previous fallback timer is no longer relevant.
     */
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    /*
     * This reload now owns the next polling window.
     */
    const generation = generationRef.current;

    try {
      await callbackRef.current();
    } finally {
      /*
       * Only schedule if another WSS reload hasn't happened
       * while this request was running.
       */
      if (generation === generationRef.current) {
        schedule();
      }
    }
  }, [schedule]);

  useEffect(() => {
    if (!enabled) return;

    /*
     * Initial load is treated as a fallback poll.
     */
    void poll();

    return () => {
      /*
       * Invalidate any in-flight request so it cannot schedule
       * another timer after the component unmounts.
       */
      generationRef.current++;

      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, poll, resetKey]);

  return {
    poll,
    reload,
  };
}