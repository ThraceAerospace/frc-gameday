import type { TBATeam } from "@fieldview/provider-tba/types";
import type { StatboticsTeamYear } from "@fieldview/provider-statbotics/types";
import type { TeamKey } from "./ids.js";

/**
 * Canonical FieldView team object. TBA-sourced fields retain their exact
 * provider names, types, nullability, and values.
 */
export interface FieldViewTeam extends TBATeam {}

/** A team's season-scoped information; source data remains provider-typed. */
export interface FieldViewTeamSeason {
  team_key: TeamKey;
  year: number;
  statbotics?: StatboticsTeamYear;
}
