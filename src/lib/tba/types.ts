import type { components } from "./generated";

export type TBAEvent = components["schemas"]["Event"];
export type TBAEventSimple = components["schemas"]["Event_Simple"];
export type TBATeam = components["schemas"]["Team"];
export type TBATeamSimple = components["schemas"]["Team_Simple"];
export type TBATeamEventStatus = components["schemas"]["Team_Event_Status"];
export type TBAAward = components["schemas"]["Award"];
export type TBAMatch = components["schemas"]["Match"];
export type TBAMatchSimple = components["schemas"]["Match_Simple"];
export type TBAEliminationAlliance = components["schemas"]["Elimination_Alliance"];
export type TBADistrict = components["schemas"]["District"];
export type TBADistrictAdvancement = components["schemas"]["District_Advancement"];
export type TBADistrictAdvancementResponse = components["schemas"]["District_Advancement_Response"];
export type TBADistrictRanking = components["schemas"]["District_Ranking"];
export type TBAWebcast = components["schemas"]["Webcast"];
export type TBAEventRanking = components["schemas"]["Event_Ranking"];
export type TBAEventOPRs = components["schemas"]["Event_OPRs"];

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
