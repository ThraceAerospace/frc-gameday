import type { TBAEvent, TBAMatch, TBATeam } from "@fieldview/provider-tba/types";

/** Unchanged source identifier aliases; no parsing or value conversion occurs. */
export type TeamKey = TBATeam["key"];
export type EventKey = TBAEvent["key"];
export type MatchKey = TBAMatch["key"];

/** Statbotics uses numeric team identifiers, distinct from TBA string keys. */
export type StatboticsTeamId = number;
