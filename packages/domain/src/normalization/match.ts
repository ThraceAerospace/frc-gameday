import type {
  TBAEventMatchPrediction,
  TBAEventOPRs,
  TBAMatch,
  TBATeam,
} from "@fieldview/provider-tba/types";
import type { StatboticsMatch } from "@fieldview/provider-statbotics/types";
import type { FieldViewMatch, FieldViewMatchTeam } from "../match.js";
import type { FieldViewSourceMetadata } from "../source-metadata.js";
import type { TeamKey } from "../ids.js";

export type TBAStatboticsTeamLookup = Pick<TBATeam, "key" | "team_number">;

export interface NormalizeFieldViewMatchInput {
  tba_match: TBAMatch;
  /** TBA team records; their team_number values correlate with Statbotics team values. */
  tba_teams?: readonly TBAStatboticsTeamLookup[];
  statbotics_match?: StatboticsMatch;
  tba_event_prediction?: TBAEventMatchPrediction;
  tba_event_oprs?: TBAEventOPRs;
  sources: FieldViewSourceMetadata;
}

function normalizeAllianceTeams(
  teamKeys: readonly TeamKey[],
  input: NormalizeFieldViewMatchInput,
): FieldViewMatchTeam[] {
  return teamKeys.map((team_key) => {
    const tbaTeam = input.tba_teams?.find((team) => team.key === team_key);
    const team_number = tbaTeam?.team_number;
    const statboticsKey = team_number === undefined ? undefined : String(team_number);
    const opr = input.tba_event_oprs?.oprs?.[team_key];
    const dpr = input.tba_event_oprs?.dprs?.[team_key];
    const ccwm = input.tba_event_oprs?.ccwms?.[team_key];
    const preEpa = statboticsKey === undefined ? undefined : input.statbotics_match?.pre_epas?.[statboticsKey];
    const epa = statboticsKey === undefined ? undefined : input.statbotics_match?.epas?.[statboticsKey];

    return {
      team_key,
      ...(team_number === undefined ? {} : { team_number }),
      ...(opr === undefined ? {} : { opr }),
      ...(dpr === undefined ? {} : { dpr }),
      ...(ccwm === undefined ? {} : { ccwm }),
      ...(preEpa === undefined ? {} : { pre_epa: preEpa }),
      ...(epa === undefined ? {} : { epa }),
    };
  });
}

/**
 * Compose unchanged source observations. Statbotics team numbers are correlated
 * with TBA's official team_number; TBA keys are never parsed or rewritten.
 * The number is stringified only to index Statbotics' string-keyed EPA maps.
 */
export function normalizeFieldViewMatch(
  input: NormalizeFieldViewMatchInput,
): FieldViewMatch {
  const { tba_match, statbotics_match } = input;
  return {
    ...tba_match,
    ...(statbotics_match === undefined ? {} : {
      statbotics_week: statbotics_match.week,
      statbotics_elim: statbotics_match.elim,
      statbotics_match_name: statbotics_match.match_name,
      statbotics_status: statbotics_match.status,
      statbotics_alliances: statbotics_match.alliances,
      statbotics_result: statbotics_match.result,
    }),
    predictions: {
      ...(input.tba_event_prediction === undefined ? {} : { tba: input.tba_event_prediction }),
      ...(statbotics_match?.pred === undefined ? {} : { statbotics: statbotics_match.pred }),
    },
    teams: {
      red: normalizeAllianceTeams(tba_match.alliances.red.team_keys, input),
      blue: normalizeAllianceTeams(tba_match.alliances.blue.team_keys, input),
    },
    sources: input.sources,
  };
}
