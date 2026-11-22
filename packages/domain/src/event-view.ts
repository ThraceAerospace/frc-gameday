import type { TeamKey } from "./ids.js";
import type { FieldViewEventState } from "./event.js";
import type { FieldViewEventAnalytics } from "./analytics.js";
import type { FieldViewTeamEventStateReference } from "./team.js";

/**
 * Bounded event read projection. It may compose event-owned state and
 * analytics for a consumer, but it never embeds TeamRuntime-owned canonical
 * TeamEventState records.
 */
export interface FieldViewEventView {
  /** EventRuntime-owned canonical state, separate from event analytics. */
  event: Omit<FieldViewEventState, "analytics">;
  /** EventRuntime-owned event-wide analytics. */
  analytics: FieldViewEventAnalytics | null;
  /** Logical references to participant TeamRuntime records. */
  team_state_refs: FieldViewTeamEventStateReference[];
  /** Explicit roster coverage; missing teams are never silently complete. */
  team_state_coverage: {
    state: "complete" | "partial";
    expected_count: number;
    materialized_count: number;
    pending_team_keys: TeamKey[];
  };
}
