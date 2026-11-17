import type { components } from "./generated.js";

export type TBAEvent = components["schemas"]["Event"];
export type TBAEventSimple = components["schemas"]["Event_Simple"];
export type TBATeam = components["schemas"]["Team"];
export type TBATeamSimple = components["schemas"]["Team_Simple"];

// The live Team Event Status response includes these year/bracket-specific
// playoff fields, although they are not currently described in TBA's OpenAPI
// schema. Keep the generated file untouched and extend the provider-facing
// type until the upstream schema catches up.
type TBATeamEventPlayoffStatus = NonNullable<
  components["schemas"]["Team_Event_Status"]["playoff"]
> & {
  playoff_type?: components["schemas"]["PlayoffType"] | null;
  double_elim_round?: components["schemas"]["Double_Elim_Round"];
};

export type TBATeamEventStatus = Omit<components["schemas"]["Team_Event_Status"], "playoff"> & {
  playoff?: TBATeamEventPlayoffStatus | null;
};

export type TBAAward = components["schemas"]["Award"];
export type TBATeamAvatar = components["schemas"]["Media_Avatar"];
export type TBAMedia = components["schemas"]["Media"];
// TBA's live 2026 match response includes hubScore.uncounted and
// alliance-level penalties, which are missing from the generated schema.
// Extend the affected nested provider types here; leave generated types alone.
type TBA2026HubScore = components["schemas"]["HubScore_2026"] & {
  uncounted?: number;
};

type TBA2026MatchAlliance =
  components["schemas"]["Match_Score_Breakdown_2026_Alliance"] & {
    hubScore: TBA2026HubScore;
    penalties?: string;
  };

type TBA2026MatchScoreBreakdown =
  components["schemas"]["Match_Score_Breakdown_2026"] & {
    red: TBA2026MatchAlliance;
    blue: TBA2026MatchAlliance;
  };

export type TBAMatch = components["schemas"]["Match"] & {
  score_breakdown?: TBA2026MatchScoreBreakdown | null;
};
export type TBAMatchSimple = components["schemas"]["Match_Simple"];
export type TBAEliminationAlliance = components["schemas"]["Elimination_Alliance"];
export type TBADistrict = components["schemas"]["District"];
export type TBADistrictAdvancement = components["schemas"]["District_Advancement"];
export type TBADistrictAdvancementResponse = components["schemas"]["District_Advancement_Response"];
export type TBADistrictRanking = components["schemas"]["District_Ranking"];
export type TBAWebcast = components["schemas"]["Webcast"];
export type TBAEventRanking = components["schemas"]["Event_Ranking"];
export type TBAEventOPRs = components["schemas"]["Event_OPRs"];
export type TBAEventAdvancementPoints = components["schemas"]["Event_District_Points"];

/**
 * Provider-owned shape of one entry in TBA's event predictions dictionary.
 *
 * The TBA OpenAPI schema currently describes Event_Predictions as an empty
 * record, so this explicit type is based on the endpoint response shape
 * supplied for the 2026 game. Field names and units intentionally match TBA.
 */
export interface TBAEventAlliancePrediction {
  score: number;
  score_var: number;
  totalAutoPoints: number;
  totalAutoPoints_var: number;
  prob_energized_bonus: number;
  totalTeleopPoints: number;
  totalTeleopPoints_var: number;
  prob_supercharged_bonus: number;
  endGameTowerPoints: number;
  endGameTowerPoints_var: number;
  prob_traversal_bonus: number;
}

export interface TBAEventMatchPrediction {
  winning_alliance: TBAMatch["winning_alliance"];
  prob: number;
  red: TBAEventAlliancePrediction;
  blue: TBAEventAlliancePrediction;
}

/** TBA event-predictions response, keyed by the unchanged TBA match key. */
export type TBAEventPredictions = Record<string, TBAEventMatchPrediction>;

export type TBAEventWithTeams = TBAEvent & {
  teams: TBATeam[];
};

export type TBAEventWithMatches = TBAEvent & {
  teams: TBATeam[];
  matches: TBAMatchSimple[];
  flags: {
    isPastStart: boolean;
    hasDivisions: boolean;
    hasMatches: boolean;
    hasPlayedMatches: boolean;
  };
};

export type TBAEventTeamStatuses = Record<string, TBATeamEventStatus | null>;
export type TBADistrictAdvancementMap = Record<string, TBADistrictAdvancement>;
