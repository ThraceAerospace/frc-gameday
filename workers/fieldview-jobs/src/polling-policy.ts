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
): Array<{ event: TbaEvent; lifecycle: "active" }> {
  return events
    .filter((event) => event && typeof event.key === "string" &&
      registeredEventKeys.has(event.key) && isValidEventLifecycleInput(event))
    .map((event) => ({ event, lifecycle: lifecycleFor(event, now).lifecycle }))
    .filter((item): item is { event: TbaEvent; lifecycle: "active" } =>
      item.lifecycle === "active")
    .sort((a, b) => a.event.start_date.localeCompare(b.event.start_date));
}
