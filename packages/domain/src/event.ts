import type {
  TBAEvent,
  TBAEventOPRs,
  TBATeamEventStatus,
} from "@fieldview/provider-tba/types";
import type { EventKey, TeamKey } from "./ids.js";

/** Canonical event object retaining all original TBA event fields and types. */
export interface FieldViewEvent extends TBAEvent {}

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
}
