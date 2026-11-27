import type {
  TBAEvent,
  TBAEventOPRs,
  TBAEventRanking,
  TBAEventAdvancementPoints,
  TBAAward,
  TBATeamEventStatus,
} from "@fieldview/provider-tba/types";
import type { EventKey, TeamKey } from "./ids.js";
import type { FieldViewSourceMetadata } from "./source-metadata.js";
import type { FieldViewTeam } from "./team.js";
import type { FieldViewMatch } from "./match.js";
import type { FieldViewEventAnalytics } from "./analytics.js";
import type { FieldViewPlayoffAlliance } from "./playoff-alliance.js";

/** Canonical event object retaining all original TBA event fields and types. */
export interface FieldViewEvent extends TBAEvent {
  /** Provenance for the retained TBA event resource. */
  sources: FieldViewSourceMetadata;
}

/**
 * A team's participation in one event. The TBA status object is passed
 * through with its original provider type. OPR/DPR/CCWM are associated from
 * the separate event OPR resource; they are not fields from the TBA match.
 */
export interface FieldViewEventTeam {
  event_key: EventKey;
  team_key: TeamKey;
  tba_status?: TBATeamEventStatus | null;
  opr?: NonNullable<TBAEventOPRs["oprs"]>[string];
  dpr?: NonNullable<TBAEventOPRs["dprs"]>[string];
  ccwm?: NonNullable<TBAEventOPRs["ccwms"]>[string];
  /** Provenance for team-event status and event-level OPR resources. */
  sources: FieldViewSourceMetadata;
}

/**
 * The assembled totality of what FieldView currently knows about an event.
 * Optional resources distinguish not acquired from explicit null and empty.
 */
export interface FieldViewEventState {
  event_key: EventKey;
  sources: {
    event: FieldViewSourceMetadata;
    teams: FieldViewSourceMetadata;
    event_teams: FieldViewSourceMetadata;
    matches: FieldViewSourceMetadata;
    playoff_alliances: FieldViewSourceMetadata;
    rankings?: FieldViewSourceMetadata;
    awards?: FieldViewSourceMetadata;
    advancement_points?: FieldViewSourceMetadata;
  };
  event?: FieldViewEvent | null;
  teams?: FieldViewTeam[] | null;
  event_teams?: FieldViewEventTeam[] | null;
  matches?: FieldViewMatch[] | null;
  playoff_alliances?: FieldViewPlayoffAlliance[] | null;
  /** Backend-calculated event-wide analytics; null means explicitly unavailable. */
  analytics?: FieldViewEventAnalytics | null;
  /** Unchanged TBA event rankings, including extra-stat metadata. */
  rankings?: TBAEventRanking | null;
  /** Unchanged TBA event awards; recipients retain their provider shape. */
  awards?: TBAAward[] | null;
  /** Unchanged TBA event advancement-points resource. */
  advancement_points?: TBAEventAdvancementPoints | null;
}

