import type {
  TBAEventMatchPrediction,
  TBAEventOPRs,
  TBAMatch,
} from "@fieldview/provider-tba/types";
import type {
  StatboticsMatch,
  StatboticsTeamId,
} from "@fieldview/provider-statbotics/types";
import type { FieldViewMatch, FieldViewMatchTeam } from "../match.js";
import type { FieldViewSourceMetadata } from "../source-metadata.js";
import type { TeamKey } from "../ids.js";

/**
 * An explicit cross-provider identity association. The numeric Statbotics ID
 * is supplied by the caller; normalization never derives it from a TBA key.
 */
export interface FieldViewTeamIdentityAssociation {
  tba_team_key: TeamKey;
  statbotics_team_id: StatboticsTeamId;
}

/** Independent provider resources supplied to the domain normalization step. */
export interface NormalizeFieldViewMatchInput {
  tba_match: TBAMatch;
  statbotics_match?: StatboticsMatch;
  tba_event_prediction?: TBAEventMatchPrediction;
  tba_event_oprs?: TBAEventOPRs;
  team_associations?: readonly FieldViewTeamIdentityAssociation[];
  sources: FieldViewSourceMetadata;
}

function normalizeAllianceTeams(
  teamKeys: readonly TeamKey[],
  input: NormalizeFieldViewMatchInput,
): FieldViewMatchTeam[] {
  return teamKeys.map((team_key) => {
    const identity = input.team_associations?.find(
      (association) => association.tba_team_key === team_key,
    );
    const statboticsKey =
      identity === undefined ? undefined : String(identity.statbotics_team_id);

    return {
      team_key,
      ...(identity === undefined
        ? {}
        : { statbotics_team_id: identity.statbotics_team_id }),
      ...(input.tba_event_oprs?.oprs?.[team_key] === undefined
        ? {}
        : { opr: input.tba_event_oprs.oprs[team_key] }),
      ...(input.tba_event_oprs?.dprs?.[team_key] === undefined
        ? {}
        : { dpr: input.tba_event_oprs.dprs[team_key] }),
      ...(input.tba_event_oprs?.ccwms?.[team_key] === undefined
        ? {}
        : { ccwm: input.tba_event_oprs.ccwms[team_key] }),
      ...(statboticsKey === undefined ||
      input.statbotics_match?.pre_epas?.[statboticsKey] === undefined
        ? {}
        : { pre_epa: input.statbotics_match.pre_epas[statboticsKey] }),
      ...(statboticsKey === undefined ||
      input.statbotics_match?.epas?.[statboticsKey] === undefined
        ? {}
        : { epa: input.statbotics_match.epas[statboticsKey] }),
    };
  });
}

/**
 * Compose unchanged source observations into the canonical FieldView match.
 *
 * This function associates resources only. It does not rewrite provider
 * payloads, infer cross-provider identities, calculate analytics, or choose
 * one provider's prediction over another. The numeric Statbotics ID is
 * stringified solely to look up the provider's string-keyed EPA maps; the
 * original numeric ID is retained in the resulting association.
 */
export function normalizeFieldViewMatch(
  input: NormalizeFieldViewMatchInput,
): FieldViewMatch {
  const { tba_match, statbotics_match } = input;

  return {
    ...tba_match,
    ...(statbotics_match === undefined
      ? {}
      : {
          statbotics_week: statbotics_match.week,
          statbotics_elim: statbotics_match.elim,
          statbotics_match_name: statbotics_match.match_name,
          statbotics_status: statbotics_match.status,
          statbotics_alliances: statbotics_match.alliances,
          statbotics_result: statbotics_match.result,
        }),
    predictions: {
      ...(input.tba_event_prediction === undefined
        ? {}
        : { tba: input.tba_event_prediction }),
      ...(statbotics_match?.pred === undefined
        ? {}
        : { statbotics: statbotics_match.pred }),
    },
    teams: {
      red: normalizeAllianceTeams(tba_match.alliances.red.team_keys, input),
      blue: normalizeAllianceTeams(tba_match.alliances.blue.team_keys, input),
    },
    sources: input.sources,
  };
}
