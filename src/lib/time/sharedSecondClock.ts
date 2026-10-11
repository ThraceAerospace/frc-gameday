"use client";

import { useEffect, useState } from "react";

type ClockSubscriber = (now: number) => void;

class SharedSecondClock {
  private readonly subscribers = new Set<ClockSubscriber>();
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  subscribe(subscriber: ClockSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(Date.now());
    this.ensureStarted();
    return () => {
      this.subscribers.delete(subscriber);
      this.stopIfIdle();
    };
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    if (!this.started) return;
    const delay = 1_000 - (Date.now() % 1_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      const tickTime = Date.now();
      this.scheduleNextTick();
      for (const subscriber of this.subscribers) {
        try {
          subscriber(tickTime);
        } catch (error) {
          console.error("[SharedSecondClock] Subscriber failed", error);
        }
      }
      this.stopIfIdle();
    }, delay);
  }

  private stopIfIdle(): void {
    if (this.subscribers.size > 0 || !this.started) return;
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

const sharedSecondClock = new SharedSecondClock();

/** Subscribe to the one runtime-wide, second-aligned clock. */
export function useSharedSecondClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => sharedSecondClock.subscribe(setNow), []);
  return now;
}
