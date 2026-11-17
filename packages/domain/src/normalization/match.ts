import type {
  TBAEventMatchPrediction,
  TBAEventOPRs,
  TBAMatch,
  TBATeam,
} from "@fieldview/provider-tba/types";
import type { StatboticsMatch } from "@fieldview/provider-statbotics/types";
import type { FieldViewMatch, FieldViewMatchTeam } from "../match.js";
import type { FieldViewPlayoffAlliance } from "../playoff-alliance.js";
import type { FieldViewEventTeam } from "../event.js";
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
  /** Canonical event-team records containing unchanged TBA status objects. */
  event_teams?: readonly FieldViewEventTeam[] | null;
  /** Event's TBA elimination alliances, associated by their explicit alliance names. */
  tba_playoff_alliances?: readonly FieldViewPlayoffAlliance[] | null;
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
 * TBA Team Event Status exposes alliance.name for each team, and the
 * elimination-alliance resource exposes the corresponding name. Correlate
 * match team keys through their unchanged status records and resolve only an
 * exact name match. Two distinct match teams reporting the same non-null name
 * are sufficient, including either side of a backup substitution. Names that
 * are absent, null, or non-unique remain unresolved; response order is never
 * treated as an identity.
 */
export function associateMatchPlayoffAlliance(
  matchTeamKeys: readonly TeamKey[],
  eventTeams: readonly FieldViewEventTeam[],
  playoffAlliances: readonly FieldViewPlayoffAlliance[],
): FieldViewPlayoffAlliance | null {
  const countsByName = new Map<string, number>();
  for (const teamKey of new Set(matchTeamKeys)) {
    const name = eventTeams.find((team) => team.team_key === teamKey)?.tba_status?.alliance?.name;
    if (name !== undefined && name !== null) countsByName.set(name, (countsByName.get(name) ?? 0) + 1);
  }
  const candidates = [...countsByName].filter(([, count]) => count >= 2).map(([name]) => name);
  if (candidates.length !== 1) return null;
  const matches = playoffAlliances.filter((alliance) => alliance.name === candidates[0]);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Compose unchanged source observations and approved associations. Statbotics
 * team numbers are correlated with TBA's official team_number; TBA keys are
 * never parsed or rewritten.
 */
export function normalizeFieldViewMatch(
  input: NormalizeFieldViewMatchInput,
): FieldViewMatch {
  const { tba_match, statbotics_match, event_teams, tba_playoff_alliances } = input;
  const playoff_alliances = tba_match.comp_level === "qm"
    ? null
    : event_teams === undefined || tba_playoff_alliances === undefined
      ? undefined
      : event_teams === null || tba_playoff_alliances === null
        ? { red: null, blue: null }
        : {
            red: associateMatchPlayoffAlliance(tba_match.alliances.red.team_keys, event_teams, tba_playoff_alliances),
            blue: associateMatchPlayoffAlliance(tba_match.alliances.blue.team_keys, event_teams, tba_playoff_alliances),
          };

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
    ...(playoff_alliances === undefined ? {} : { playoff_alliances }),
    sources: input.sources,
  };
}
