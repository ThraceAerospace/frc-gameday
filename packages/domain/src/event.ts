import type {
  TBAEvent,
  TBAEventOPRs,
  TBATeamEventStatus,
} from "@fieldview/provider-tba/types";
import type { EventKey, TeamKey } from "./ids.js";
import type { FieldViewSourceMetadata } from "./source-metadata.js";

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
