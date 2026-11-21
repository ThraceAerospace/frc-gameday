import type { EventKey, TeamKey } from "./ids.js";
import type { FieldViewEventState } from "./event.js";
import type { FieldViewEventAnalytics } from "./analytics.js";

/**
 * Logical foreign key to a TeamRuntime-owned event state.
 *
 * The team key selects the TeamRuntime Durable Object; event_key selects the
 * record within that runtime. The revision identifies the state observed by
 * the event analytics operation. It is not a copy of the referenced record.
 */
export interface FieldViewTeamEventStateReference {
  owner: "team-runtime";
  owner_id: TeamKey;
  record_type: "team-event-state";
  record_id: EventKey;
  revision: number | null;
}

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
