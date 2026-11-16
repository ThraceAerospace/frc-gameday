import type { TBAEvent, TBAMatch, TBATeam } from "@fieldview/provider-tba/types";
import type { StatboticsMatch } from "@fieldview/provider-statbotics/types";

/** Unchanged source identifier aliases; no parsing or value conversion occurs. */
export type TeamKey = TBATeam["key"];
export type EventKey = TBAEvent["key"];
export type MatchKey = TBAMatch["key"];

/**
 * Statbotics' original numeric team-key type, taken from its match alliance
 * schema rather than widened to a generic number.
 */
export type StatboticsTeamId = NonNullable<
  NonNullable<
    NonNullable<StatboticsMatch["alliances"]>["red"]
  >["team_keys"]
>[number];
