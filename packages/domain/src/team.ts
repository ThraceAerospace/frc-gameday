import type { TBATeam } from "@fieldview/provider-tba/types";

/**
 * The TBA team payload as received.
 *
 * This is a direct type alias: field names, values, nullability, and structure
 * are unchanged. Any future FieldView-derived values must be separate,
 * explicitly named fields with documented and approved transformations.
 */
export type FieldViewTeam = TBATeam;

/**
 * A FieldView season-scoped team reference. teamKey is the unchanged TBA key;
 * year identifies the FieldView season and does not transform provider data.
 */
export interface FieldViewTeamSeason {
  teamKey: TBATeam["key"];
  year: number;
}
