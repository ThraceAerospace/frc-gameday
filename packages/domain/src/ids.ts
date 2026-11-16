import type { TBAEvent, TBAMatch, TBATeam } from "@fieldview/provider-tba/types";

/**
 * Source identifier type aliases.
 *
 * These aliases preserve provider key types exactly. They do not brand,
 * validate, parse, or transform identifier values.
 */
export type TeamKey = TBATeam["key"];
export type EventKey = TBAEvent["key"];
export type MatchKey = TBAMatch["key"];
