import type { StatboticsTeamYear } from "@fieldview/provider-statbotics/types";
import type { FieldViewTeamSeason } from "../team.js";
import type { StatboticsTeamId, TeamKey } from "../ids.js";

/** Inputs are independently acquired; identity correlation is caller-supplied. */
export interface NormalizeFieldViewTeamSeasonInput {
  team_key: TeamKey;
  year: number;
  /** Explicit cross-provider association; never inferred from team_key. */
  statbotics_team_id?: StatboticsTeamId;
  /** Unchanged Statbotics team-year source record. */
  statbotics_team_year?: StatboticsTeamYear;
}

/**
 * Compose one team's season-scoped domain object.
 *
 * The Statbotics record is retained unchanged. Its association with the TBA
 * team key is represented only when the caller supplies the explicit numeric
 * Statbotics identity; no identifier parsing or source-field rewriting occurs.
 */
export function normalizeFieldViewTeamSeason(
  input: NormalizeFieldViewTeamSeasonInput,
): FieldViewTeamSeason {
  return {
    team_key: input.team_key,
    year: input.year,
    ...(input.statbotics_team_id === undefined
      ? {}
      : { statbotics_team_id: input.statbotics_team_id }),
    ...(input.statbotics_team_year === undefined
      ? {}
      : { statbotics: input.statbotics_team_year }),
  };
}
