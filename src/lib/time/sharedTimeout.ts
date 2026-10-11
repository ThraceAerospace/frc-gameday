"type ScheduledTask = {
  id: number;
  dueAt: number;
  callback: () => void;
};

class SharedTimeoutScheduler {
  private readonly tasks = new Map<number, ScheduledTask>();
  private nextId = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  schedule(callback: () => void, delayMs: number): () => void {
    const id = ++this.nextId;
    this.tasks.set(id, {
      id,
      dueAt: Date.now() + Math.max(0, delayMs),
      callback,
    });
    this.reschedule();
    return () => {
      this.tasks.delete(id);
      this.reschedule();
    };
  }

  private reschedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.tasks.size === 0) return;

    let nextDueAt = Number.POSITIVE_INFINITY;
    for (const task of this.tasks.values()) {
      nextDueAt = Math.min(nextDueAt, task.dueAt);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      const now = Date.now();
      const due = [...this.tasks.values()].filter((task) => task.dueAt <= now);
      for (const task of due) {
        this.tasks.delete(task.id);
        try {
          task.callback();
        } catch (error) {
          console.error("[SharedTimeoutScheduler] Task failed", error);
        }
      }
      this.reschedule();
    }, Math.max(0, nextDueAt - Date.now()));
  }
}

const scheduler = new SharedTimeoutScheduler();

/** Schedule deadline work on one runtime-wide timer queue. */
export function scheduleSharedTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  return scheduler.schedule(callback, delayMs);
}
