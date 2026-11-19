import type { TBADistrict, TBAMedia, TBAEvent, TBATeam } from "@fieldview/provider-tba/types";
import type { TeamKey, EventKey } from "./ids.js";
import type { FieldViewSourceMetadata } from "./source-metadata.js";
import type { FieldViewEventTeam } from "./event.js";
import type { FieldViewMatch } from "./match.js";
import type { FieldViewTeamAnalytics } from "./analytics.js";
import type { FRCColorsTeam } from "@fieldview/provider-frc-colors/types";

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
 * FieldViewTeamState, which is scoped to one team's participation at an event.
 */
export interface FieldViewTeamSnapshot {
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

/**
 * The assembled totality of what FieldView knows about one team at one event.
 * Match objects retain their complete canonical alliance context; the state
 * selects only matches in which this team appeared.
 */
export interface FieldViewTeamState {
  event_key: EventKey;
  team_key: TeamKey;
  sources: {
    team: FieldViewSourceMetadata;
    event_team: FieldViewSourceMetadata;
    matches: FieldViewSourceMetadata;
  };
  team?: FieldViewTeam | null;
  event_team?: FieldViewEventTeam | null;
  matches?: FieldViewMatch[] | null;
  analytics?: FieldViewTeamAnalytics | null;
}

/** A team's season-scoped Statbotics record correlated by official TBA team number. */
export interface FieldViewTeamSeason {
  team_key: TeamKey;
  year: number;
  team_number: TBATeam["team_number"];
  statbotics?: import("@fieldview/provider-statbotics/types").StatboticsTeamYear;
  sources: FieldViewSourceMetadata;
}
