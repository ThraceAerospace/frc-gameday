"use client";

import { useEffect, useState } from "react";

type ClockSubscriber = (now: number) => void;

/**
 * A browser-session-wide wall-clock ticker.
 *
 * The first subscriber starts one timeout aligned to the next second boundary.
 * That timeout is then rescheduled once per second for the lifetime of the page,
 * and every subscriber receives the same timestamp for each tick.
 */
class SharedSecondClock {
  private readonly subscribers = new Set<ClockSubscriber>();
  private started = false;

  subscribe(subscriber: ClockSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(Date.now());

    if (!this.started) {
      this.started = true;
      this.scheduleNextTick();
    }

    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private scheduleNextTick(): void {
    const now = Date.now();
    const delay = 1_000 - (now % 1_000);

    window.setTimeout(() => {
      const tickTime = Date.now();

      for (const subscriber of this.subscribers) {
        subscriber(tickTime);
      }

      this.scheduleNextTick();
    }, delay);
  }
}

const sharedSecondClock = new SharedSecondClock();

/**
 * Subscribe a component to the single shared, second-aligned browser clock.
 * The service deliberately remains active after the last unsubscribe, so
 * components mounted later reuse the same session-wide ticker.
 */
export function useSharedSecondClock(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => sharedSecondClock.subscribe(setNow), []);

  return now;
}
