import type {
  TBAEventMatchPrediction,
  TBAEventOPRs,
  TBAMatch,
  TBATeam,
} from "@fieldview/provider-tba/types";
import type { StatboticsMatch } from "@fieldview/provider-statbotics/types";
import type { FieldViewMatch, FieldViewMatchTeam } from "../match.js";
import type { FieldViewPlayoffAlliance } from "../playoff-alliance.js";
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
  /** Event's unchanged TBA elimination alliances; omitted until acquired. */
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
 * TBA playoff alliances contain the four roster members: three picks and,
 * when used, both the incoming and outgoing backup teams. A match has three
 * teams on the field; at most one roster member can differ from the picks.
 * Two distinct match team keys therefore identify an alliance. Return an
 * association only when exactly one alliance meets that threshold.
 */
export function associateMatchPlayoffAlliance(
  matchTeamKeys: readonly TeamKey[],
  playoffAlliances: readonly FieldViewPlayoffAlliance[],
): FieldViewPlayoffAlliance | null {
  const matchTeams = new Set(matchTeamKeys);
  const matches = playoffAlliances.filter((alliance) => {
    const roster = new Set(alliance.picks);
    if (alliance.backup) {
      roster.add(alliance.backup.in);
      roster.add(alliance.backup.out);
    }
    let overlap = 0;
    for (const teamKey of matchTeams) {
      if (roster.has(teamKey)) overlap += 1;
    }
    return overlap >= 2;
  });
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
  const { tba_match, statbotics_match, tba_playoff_alliances } = input;
  const playoff_alliances = tba_match.comp_level === "qm"
    ? null
    : tba_playoff_alliances === undefined
      ? undefined
      : {
          red: tba_playoff_alliances === null
            ? null
            : associateMatchPlayoffAlliance(tba_match.alliances.red.team_keys, tba_playoff_alliances),
          blue: tba_playoff_alliances === null
            ? null
            : associateMatchPlayoffAlliance(tba_match.alliances.blue.team_keys, tba_playoff_alliances),
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
