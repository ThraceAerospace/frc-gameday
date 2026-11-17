/**
 * Provider-relative TBA v3 path builders. No fetching, caching, or normalization.
 */
export const TBA_ENDPOINTS = {
  event: (key: string) => `/event/${segment(key)}`,
  eventTeams: (key: string) => `/event/${segment(key)}/teams`,
  eventTeamStatuses: (key: string) => `/event/${segment(key)}/teams/statuses`,
  eventMatches: (key: string) => `/event/${segment(key)}/matches`,
  eventAlliances: (key: string) => `/event/${segment(key)}/alliances`,
  eventOPRs: (key: string) => `/event/${segment(key)}/oprs`,
  eventPredictions: (key: string) => `/event/${segment(key)}/predictions`,
  eventRankings: (key: string) => `/event/${segment(key)}/rankings`,
  eventAwards: (key: string) => `/event/${segment(key)}/awards`,
  eventMedia: (key: string) => `/event/${segment(key)}/media`,
  eventDistrictPoints: (key: string) => `/event/${segment(key)}/district_points`,
  eventAdvancementPoints: (key: string) => `/event/${segment(key)}/advancement_points`,
  match: (key: string) => `/match/${segment(key)}`,
  team: (key: string) => `/team/${segment(key)}`,
  teamEventStatus: (teamKey: string, eventKey: string) =>
    `/team/${segment(teamKey)}/event/${segment(eventKey)}/status`,
} as const;

function segment(value: string): string {
  if (!value || value.trim() !== value) {
    throw new Error("TBA path parameters must be non-empty and have no surrounding whitespace");
  }
  return encodeURIComponent(value);
}
