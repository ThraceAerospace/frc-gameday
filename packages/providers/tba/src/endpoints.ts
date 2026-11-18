/**
 * Provider-relative TBA v3 path builders. No fetching, caching, or normalization.
 */
export const TBA_ENDPOINTS = {
  events: (year: number) => `/events/${year}`,
  teams: (year: number) => `/teams/${year}`,
  eventsSimple: (year: number) => `/events/${year}/simple`,
  event: (key: string) => `/event/${segment(key)}`,
  eventSimple: (key: string) => `/event/${segment(key)}/simple`,
  eventTeams: (key: string) => `/event/${segment(key)}/teams`,
  eventTeamsSimple: (key: string) => `/event/${segment(key)}/teams/simple`,
  eventTeamKeys: (key: string) => `/event/${segment(key)}/teams/keys`,
  eventTeamStatuses: (key: string) => `/event/${segment(key)}/teams/statuses`,
  eventMatches: (key: string) => `/event/${segment(key)}/matches`,
  eventMatchesSimple: (key: string) => `/event/${segment(key)}/matches/simple`,
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
  teamMedia: (teamKey: string, year: number) =>
    `/team/${segment(teamKey)}/media/${year}`,
  teamDistricts: (teamKey: string) => `/team/${segment(teamKey)}/districts`,
  teamEvents: (teamKey: string, year: number) =>
    `/team/${segment(teamKey)}/events/${year}`,
  teamEventStatus: (teamKey: string, eventKey: string) =>
    `/team/${segment(teamKey)}/event/${segment(eventKey)}/status`,
  teamEventAwards: (teamKey: string, eventKey: string) =>
    `/team/${segment(teamKey)}/event/${segment(eventKey)}/awards`,
  teamEventMatches: (teamKey: string, eventKey: string) =>
    `/team/${segment(teamKey)}/event/${segment(eventKey)}/matches`,
  teamEventMatchesSimple: (teamKey: string, eventKey: string) =>
    `/team/${segment(teamKey)}/event/${segment(eventKey)}/matches/simple`,
  districts: (year: number) => `/districts/${year}`,
  districtTeams: (key: string) => `/district/${segment(key)}/teams`,
  districtTeamKeys: (key: string) => `/district/${segment(key)}/teams/keys`,
  districtEvents: (key: string) => `/district/${segment(key)}/events`,
  districtRankings: (key: string) => `/district/${segment(key)}/rankings`,
  districtAdvancement: (key: string) => `/district/${segment(key)}/advancement`,
} as const;

function segment(value: string): string {
  if (!value || value.trim() !== value) {
    throw new Error("TBA path parameters must be non-empty and have no surrounding whitespace");
  }
  return encodeURIComponent(value);
}
