import { isValidEventLifecycleInput, lifecycleFor } from "./calendar.ts";
import type { TbaEvent } from "./calendar.ts";

/** Registered events eligible for coordinator polling, ordered active-first. */
export function selectPollingCandidates(
  events: TbaEvent[],
  registeredEventKeys: ReadonlySet<string>,
  now: number,
): Array<{ event: TbaEvent; lifecycle: "upcoming" | "active" }> {
  return events
    .filter((event) => event && typeof event.key === "string" &&
      registeredEventKeys.has(event.key) && isValidEventLifecycleInput(event))
    .map((event) => ({ event, lifecycle: lifecycleFor(event, now).lifecycle }))
    .filter((item): item is { event: TbaEvent; lifecycle: "upcoming" | "active" } =>
      item.lifecycle === "upcoming" || item.lifecycle === "active")
    .sort((a, b) => (a.lifecycle === b.lifecycle
      ? a.event.start_date.localeCompare(b.event.start_date)
      : a.lifecycle === "active" ? -1 : 1));
}
