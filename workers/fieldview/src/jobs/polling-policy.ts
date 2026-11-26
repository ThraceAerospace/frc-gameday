import { isValidEventLifecycleInput, lifecycleFor } from "./calendar.ts";
import type { TbaEvent } from "./calendar.ts";

/** Hard per-run limits: these cap dispatched work, not just concurrency. */
export const MAX_EVENT_CANDIDATES_PER_RUN = 8;
export const MAX_TEAM_READINESS_CHECKS_PER_RUN = 50;
export const MAX_TEAM_REFRESH_COMMANDS_PER_RUN = 20;
export const MAX_PENDING_ANALYTICS_RECOVERY_CHECKS_PER_RUN = 50;
export const MAX_PENDING_ANALYTICS_RECOVERY_EVENTS_PER_RUN = 20;

/** Return valid events that are active according to their own IANA timezone. */
export function selectActiveEvents(events: TbaEvent[], now: number): TbaEvent[] {
  return events
    .filter((event) => event && typeof event.key === "string" && isValidEventLifecycleInput(event))
    .filter((event) => lifecycleFor(event, now).lifecycle === "active")
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.key.localeCompare(b.key));
}

export function selectPollingCandidates(
  events: TbaEvent[],
  registeredEventKeys: ReadonlySet<string>,
  now: number,
  limit = MAX_EVENT_CANDIDATES_PER_RUN,
  rotationSlot = 0,
): Array<{ event: TbaEvent; lifecycle: "active" }> {
  const active = selectActiveEvents(events, now).filter((event) => registeredEventKeys.has(event.key));
  const selectedKeys = new Set(selectBudgetedKeys(active.map((item) => item.key), limit, rotationSlot));
  return active.filter((item) => selectedKeys.has(item.key)).map((event) => ({ event, lifecycle: "active" as const }));
}


/**
 * Select a bounded, deterministic rotating slice. Rotation prevents a fixed
 * lexical prefix from monopolizing the budget when the candidate set is
 * larger than one run can process.
 */
export function selectBudgetedKeys(
  keys: string[],
  limit: number,
  rotationSlot: number,
): string[] {
  const unique = [...new Set(keys)].sort();
  if (!Number.isFinite(limit) || limit <= 0 || unique.length === 0) return [];
  const count = Math.min(unique.length, Math.floor(limit));
  const slot = Number.isSafeInteger(rotationSlot) ? rotationSlot : 0;
  const start = (((slot % unique.length) * (count % unique.length)) % unique.length + unique.length) % unique.length;
  return Array.from({ length: count }, (_, index) => unique[(start + index) % unique.length]);
}


/** Rotate a bounded slice while preserving the caller's priority ordering. */
export function selectBudgetedItems<T>(
  items: T[],
  limit: number,
  rotationSlot: number,
): T[] {
  if (!Number.isFinite(limit) || limit <= 0 || items.length === 0) return [];
  const count = Math.min(items.length, Math.floor(limit));
  const slot = Number.isSafeInteger(rotationSlot) ? rotationSlot : 0;
  const start = (((slot % items.length) * (count % items.length)) % items.length + items.length) % items.length;
  return Array.from({ length: count }, (_, index) => items[(start + index) % items.length]);
}
