"use client";

import { useEffect, useState } from "react";

type ClockSubscriber = (now: number) => void;
type ScheduledTask = { dueAt: number; callback: () => void };

class SharedSecondClock {
  private readonly subscribers = new Set<ClockSubscriber>();
  private readonly tasks = new Map<number, ScheduledTask>();
  private started = false;
  private nextTaskId = 0;

  subscribe(subscriber: ClockSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(Date.now());
    this.ensureStarted();
    return () => { this.subscribers.delete(subscriber); };
  }

  schedule(callback: () => void, delayMs: number): () => void {
    const id = ++this.nextTaskId;
    this.tasks.set(id, { dueAt: Date.now() + Math.max(0, delayMs), callback });
    this.ensureStarted();
    return () => { this.tasks.delete(id); };
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    const now = Date.now();
    const delay = 1_000 - (now % 1_000);

    window.setTimeout(() => {
      const tickTime = Date.now();
      // Schedule first so a faulty callback cannot stop the shared clock.
      this.scheduleNextTick();

      for (const subscriber of this.subscribers) {
        try { subscriber(tickTime); }
        catch (error) { console.error("[SharedSecondClock] Subscriber failed", error); }
      }

      for (const [id, task] of this.tasks) {
        if (task.dueAt > tickTime) continue;
        this.tasks.delete(id);
        try { task.callback(); }
        catch (error) { console.error("[SharedSecondClock] Scheduled task failed", error); }
      }
    }, delay);
  }
}

const sharedSecondClock = new SharedSecondClock();

/** Subscribe to the one session-wide, second-aligned clock. */
export function useSharedSecondClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => sharedSecondClock.subscribe(setNow), []);
  return now;
}

/**
 * Schedule deadline work on the shared second clock instead of creating another
 * browser timeout. Tasks may run up to one second after their requested deadline.
 */
export function scheduleSharedTimeout(callback: () => void, delayMs: number): () => void {
  return sharedSecondClock.schedule(callback, delayMs);
}
