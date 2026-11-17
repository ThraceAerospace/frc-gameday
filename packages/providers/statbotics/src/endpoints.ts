export interface StatboticsFilters {
  team?: number;
  year?: number;
  event?: string;
  elim?: boolean;
}

function collectionPath(
  path: "/matches" | "/team_events",
  filters: StatboticsFilters,
  limit: number,
  offset: number,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) query.set(key, String(value));
  }
  query.set("limit", String(limit));
  query.set("offset", String(offset));
  return path + "?" + query.toString();
}

/** Provider-relative Statbotics v3 resource paths; no cache or domain logic. */
export const STATBOTICS_ENDPOINTS = {
  match: (matchKey: string) => "/match/" + encodeURIComponent(matchKey),
  teamYear: (team: number, year: number) => "/team_year/" + team + "/" + year,
  teamEvent: (team: number, eventKey: string) =>
    "/team_event/" + team + "/" + encodeURIComponent(eventKey),
  matches: (filters: StatboticsFilters = {}, limit = 1000, offset = 0) =>
    collectionPath("/matches", filters, limit, offset),
  teamEvents: (filters: Omit<StatboticsFilters, "elim"> = {}, limit = 1000, offset = 0) =>
    collectionPath("/team_events", filters, limit, offset),
} as const;
