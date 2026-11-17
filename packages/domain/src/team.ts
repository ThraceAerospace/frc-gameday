import type { TBATeam } from "@fieldview/provider-tba/types";
import type { StatboticsTeamYear } from "@fieldview/provider-statbotics/types";
import type { TeamKey } from "./ids.js";
import type { FieldViewSourceMetadata } from "./source-metadata.js";

/**
 * Canonical FieldView team object. TBA-sourced fields retain their exact
 * provider names, types, nullability, and values.
 */
export interface FieldViewTeam extends TBATeam {
  /** Provenance for the retained TBA team resource. */
  sources: FieldViewSourceMetadata;
}

/** A team's season-scoped information; source data remains provider-typed. */
export interface FieldViewTeamSeason {
  team_key: TeamKey;
  year: number;
  /** Official TBA team number, used to correlate Statbotics team values. */
  team_number: TBATeam["team_number"];
  /** Unchanged Statbotics team-year source record. */
  statbotics?: StatboticsTeamYear;
  /** Provenance for the TBA team and Statbotics team-year resources. */
  sources: FieldViewSourceMetadata;
}
