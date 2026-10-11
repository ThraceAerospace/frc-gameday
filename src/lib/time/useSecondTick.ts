"use client";

import { useEffect, useState } from "react";

type Listener = (now: number) => void;

const listeners = new Set<Listener>();
let timeout: ReturnType<typeof setTimeout> | null = null;

function stopTicker() {
  if (timeout !== null) {
    clearTimeout(timeout);
    timeout = null;
  }
}

function scheduleNextTick() {
  if (timeout !== null || listeners.size === 0) {
    return;
  }

  // Align updates to wall-clock second boundaries so every subscriber ticks
  // together instead of drifting based on when its component mounted.
  const delay = 1_000 - (Date.now() % 1_000);

  timeout = setTimeout(() => {
    timeout = null;
    const now = Date.now();

    for (const listener of listeners) {
      listener(now);
    }

    scheduleNextTick();
  }, delay);
}

/**
 * Returns a shared wall-clock timestamp that updates on aligned one-second
 * boundaries. All mounted consumers share one timeout, which is stopped when
 * the final consumer unsubscribes.
 */
export function useSecondTick(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const listener: Listener = (timestamp) => setNow(timestamp);

    listeners.add(listener);
    listener(Date.now());
    scheduleNextTick();

    return () => {
      listeners.delete(listener);

      if (listeners.size === 0) {
        stopTicker();
      }
    };
  }, []);

  return now;
}
