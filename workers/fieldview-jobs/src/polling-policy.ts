import { isValidEventLifecycleInput, lifecycleFor } from "./calendar.ts";
import type { TbaEvent } from "./calendar.ts";

/**
 * Only registered events whose event-local lifecycle is active may receive
 * recurring live polling. Upcoming events require a separate, explicitly
 * budgeted pre-event policy; they are not part of this coordinator pass.
 */
export function selectPollingCandidates(
  events: TbaEvent[],
  registeredEventKeys: ReadonlySet<string>,
  now: number,
  limit = MAX_EVENT_CANDIDATES_PER_RUN,
  rotationSlot = 0,
): Array<{ event: TbaEvent; lifecycle: "active" }> {
  const active = events
    .filter((event) => event && typeof event.key === "string" &&
      registeredEventKeys.has(event.key) && isValidEventLifecycleInput(event))
    .map((event) => ({ event, lifecycle: lifecycleFor(event, now).lifecycle }))
    .filter((item): item is { event: TbaEvent; lifecycle: "active" } =>
      item.lifecycle === "active")
    .sort((a, b) => a.event.start_date.localeCompare(b.event.start_date) || a.event.key.localeCompare(b.event.key));
  const selectedKeys = new Set(selectBudgetedKeys(active.map((item) => item.event.key), limit, rotationSlot));
  return active.filter((item) => selectedKeys.has(item.event.key));
}


/** Hard per-run limits: these cap dispatched work, not just concurrency. */
export const MAX_EVENT_CANDIDATES_PER_RUN = 8;
export const MAX_TEAM_READINESS_CHECKS_PER_RUN = 50;
export const MAX_TEAM_REFRESH_COMMANDS_PER_RUN = 20;

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
