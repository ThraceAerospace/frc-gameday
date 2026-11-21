import type { FieldViewEventState } from "./event.js";
import type { FieldViewEventAnalytics } from "./analytics.js";
import type { TeamKey } from "./ids.js";
import type { FieldViewTeamEventState } from "./team.js";

/**
 * Composed event product model. The event runtime supplies event-owned state
 * and analytics; TeamRuntime remains authoritative for each team event state.
 */
export interface FieldViewEventView {
  /** Event-owned canonical state, separate from event analytics and the TeamEventState array. */
  event: Omit<FieldViewEventState, "analytics">;
  /** Event-wide analysis calculated by EventRuntime. */
  analytics: FieldViewEventAnalytics | null;
  /** Independently persisted team/event states, one per available roster member. */
  team_states: FieldViewTeamEventState[];
  /** Explicit roster coverage; missing teams are never silently treated as complete. */
  team_state_coverage: {
    state: "complete" | "partial";
    expected_count: number;
    materialized_count: number;
    pending_team_keys: TeamKey[];
  };
}
