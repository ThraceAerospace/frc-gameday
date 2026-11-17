import type { TBATeam } from "@fieldview/provider-tba/types";
import type { StatboticsTeamYear } from "@fieldview/provider-statbotics/types";
import type { FieldViewTeamSeason } from "../team.js";
import type { TeamKey } from "../ids.js";

export interface NormalizeFieldViewTeamSeasonInput {
  team_key: TeamKey;
  team_number: TBATeam["team_number"];
  year: number;
  /** Unchanged Statbotics record selected by matching its team value. */
  statbotics_team_year?: StatboticsTeamYear;
}

/** Correlate the unchanged Statbotics record using TBA's official team_number. */
export function normalizeFieldViewTeamSeason(
  input: NormalizeFieldViewTeamSeasonInput,
): FieldViewTeamSeason {
  if (
    input.statbotics_team_year !== undefined &&
    input.statbotics_team_year.team !== input.team_number
  ) {
    throw new Error(
      `Statbotics team ${String(input.statbotics_team_year.team)} does not match TBA team number ${input.team_number}`,
    );
  }

  return {
    team_key: input.team_key,
    team_number: input.team_number,
    year: input.year,
    ...(input.statbotics_team_year === undefined
      ? {}
      : { statbotics: input.statbotics_team_year }),
  };
}
