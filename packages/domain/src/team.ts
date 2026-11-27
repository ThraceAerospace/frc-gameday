import type { TBADistrict, TBAMedia, TBAEvent, TBATeam } from "@fieldview/provider-tba/types";
import type { TeamKey, EventKey } from "./ids.js";
import type { FieldViewSourceMetadata } from "./source-metadata.js";
import type { FieldViewTeamEventAnalytics } from "./analytics.js";

/** Canonical FieldView team object; TBA fields retain their exact source shape. */
export interface FieldViewTeam extends TBATeam {
  sources: FieldViewSourceMetadata;
  /** Stable team identity colors from FRC Colors; null means no colors are registered. */
  frc_colors?: {
    primary_hex: string | null;
    secondary_hex: string | null;
    verified: boolean | null;
  } | null;
}

/**
 * Team-profile aggregate for one season. This is distinct from
 * FieldViewTeamEventState, which is scoped to one team's participation at an event.
 */
export interface FieldViewTeamState {
  team_key: TeamKey;
  year: number;
  sources: FieldViewSourceMetadata;
  team?: FieldViewTeam | null;
  districts?: TBADistrict[] | null;
  events?: TBAEvent[] | null;
  media?: TBAMedia[] | null;
  /** Statbotics season-level EPA record, acquired and cached by TeamRuntime. */
  statbotics?: import("@fieldview/provider-statbotics/types").StatboticsTeamYear | null;
  /** Statbotics event-level season history, correlated by TBA event key. */
  statbotics_events?: import("@fieldview/provider-statbotics/types").StatboticsTeamEvent[] | null;
}

/** Logical foreign key to a canonical event-owned team participation record. */
export interface FieldViewEventTeamReference {
  owner: "event-runtime";
  owner_id: EventKey;
  record_type: "event-team";
  record_id: TeamKey;
  revision: number | null;
}

/** Logical foreign key to a canonical event-owned match record. */
export interface FieldViewMatchReference {
  owner: "event-runtime";
  owner_id: EventKey;
  record_type: "match";
  record_id: string;
  revision: number | null;
}

/** Logical foreign key to a TeamRuntime-owned team/event record. */
export interface FieldViewTeamEventStateReference {
  owner: "team-runtime";
  owner_id: TeamKey;
  record_type: "team-event-state";
  record_id: EventKey;
  revision: number | null;
}

/**
 * Team-owned event participation and analytics. Event-owned team participation
 * and match records are referenced, never copied into this record.
 */
export interface FieldViewTeamEventState {
  event_key: EventKey;
  team_key: TeamKey;
  sources: {
    team: FieldViewSourceMetadata;
    event_team: FieldViewSourceMetadata;
    matches: FieldViewSourceMetadata;
  };
  event_team_ref?: FieldViewEventTeamReference | null;
  match_refs?: FieldViewMatchReference[] | null;
  analytics?: FieldViewTeamEventAnalytics | null;
}


/** A team's season-scoped Statbotics record correlated by official TBA team number. */
export interface FieldViewTeamSeason {
  team_key: TeamKey;
  year: number;
  team_number: TBATeam["team_number"];
  statbotics?: import("@fieldview/provider-statbotics/types").StatboticsTeamYear;
  sources: FieldViewSourceMetadata;
}
