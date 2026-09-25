import { tba } from "./index";
import { buildStreams } from "@/lib/gameday/buildStreams";
import type {
  TBAEliminationAlliance,
  TBAEvent,
  TBAEventSimple,
  TBAEventTeamStatuses,
  TBAEventWithMatches,
  TBAEventWithTeams,
  TBAEventOPRs,
  TBAEventRanking,
  TBADistrict,
  TBADistrictAdvancementMap,
  TBADistrictAdvancementResponse,
  TBADistrictRanking,
  TBAMatch,
  TBAMatchSimple,
  TBANexusEventInfo,
  TBATeam,
  TBATeamEventStatus,
  TBATeamSimple,
} from "./tba/types";

function parseDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function getWeekRange(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());

  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

function isEventThisWeek(event: TBAEvent, weekStart: Date, weekEnd: Date) {
  const start = parseDate(event.start_date);
  const end = parseDate(event.end_date);
  return start <= weekEnd && end >= weekStart;
}

function isMatchPlayed(match: TBAMatch | TBAMatchSimple) {
  return match.actual_time != null;
}

export const TBA = {
  getTeam: (teamKey: string): Promise<TBATeam> =>
    tba.get<TBATeam>(`/team/${teamKey}`),

  getTeamDistricts: (teamKey: string): Promise<TBADistrict[]> =>
    tba.get<TBADistrict[]>(`/team/${teamKey}/districts`),

  getTeamEvents: (teamKey: string, year: number): Promise<TBAEventSimple[]> =>
    tba.get<TBAEventSimple[]>(`/team/${teamKey}/events/${year}`),

  getTeamEventStatus: (
    teamKey: string,
    eventKey: string
  ): Promise<TBATeamEventStatus | null> =>
    tba.get<TBATeamEventStatus | null>(
      `/team/${teamKey}/event/${eventKey}/status`
    ),

  getTeamMatches: (
    teamKey: string,
    eventKey: string
  ): Promise<TBAMatch[]> =>
    tba.get<TBAMatch[]>(`/team/${teamKey}/event/${eventKey}/matches`),

  getTeamMatchesSimple: (
    teamKey: string,
    eventKey: string
  ): Promise<TBAMatchSimple[]> =>
    tba.get<TBAMatchSimple[]>(
      `/team/${teamKey}/event/${eventKey}/matches/simple`
    ),

  getEvent: (eventKey: string): Promise<TBAEvent> =>
    tba.get<TBAEvent>(`/event/${eventKey}`),

  getEventSimple: (eventKey: string): Promise<TBAEventSimple> =>
    tba.get<TBAEventSimple>(`/event/${eventKey}/simple`),

  getEvents: (year: number): Promise<TBAEvent[]> =>
    tba.get<TBAEvent[]>(`/events/${year}`),

  getEventsSimple: (year: number): Promise<TBAEventSimple[]> =>
    tba.get<TBAEventSimple[]>(`/events/${year}/simple`),

  getActiveEvents: async (year: number): Promise<TBAEvent[]> => {
    const events = await TBA.getEvents(year);
    const { start, end } = getWeekRange();

    return events.filter((event) => isEventThisWeek(event, start, end));
  },

  getActiveEventsWithTeams: async (
    year: number
  ): Promise<TBAEventWithTeams[]> => {
    const activeEvents = await TBA.getActiveEvents(year);

    return Promise.all(
      activeEvents.map(async (event) => ({
        ...event,
        teams: await TBA.getTeamsAtEvent(event.key),
      }))
    );
  },

  getActiveEventsWithMatches: async (year: number): Promise<TBAEvent[]> => {
    const events = await TBA.getEvents(year);
    const now = new Date();

    const candidates = events.filter((event) => {
      const start = parseDate(event.start_date);
      const end = parseDate(event.end_date);
      return start <= now && now <= end;
    });

    const enriched = await Promise.all(
      candidates.map(async (event) => {
        const matches = await TBA.getEventMatchesSimple(event.key);
        return matches.some(isMatchPlayed) ? event : null;
      })
    );

    return enriched.filter((event): event is TBAEvent => event !== null);
  },

  getActiveEventsFull: async (year: number): Promise<TBAEventWithMatches[]> => {
    const events = await TBA.getActiveEventsWithMatches(year);

    return Promise.all(
      events.map(async (event) => {
        const [teams, matches] = await Promise.all([
          TBA.getTeamsAtEvent(event.key),
          TBA.getEventMatchesSimple(event.key),
        ]);

        const hasDivisions = (event.division_keys?.length ?? 0) > 0;
        const hasMatches = matches.length > 0;
        const hasPlayedMatches = matches.some(isMatchPlayed);
        const isPastStart = new Date() >= parseDate(event.start_date);

        return {
          ...event,
          teams,
          matches,
          flags: {
            isPastStart,
            hasDivisions,
            hasMatches,
            hasPlayedMatches,
          },
        };
      })
    );
  },

  getEventNexusInfo: (
    eventKey: string
  ): Promise<TBANexusEventInfo | null> =>
    tba.get<TBANexusEventInfo | null>(`/event/${eventKey}/nexus_info`),

  getTeamsAtEvent: (eventKey: string): Promise<TBATeam[]> =>
    tba.get<TBATeam[]>(`/event/${eventKey}/teams`),

  getTeamsAtEventSimple: (eventKey: string): Promise<TBATeamSimple[]> =>
    tba.get<TBATeamSimple[]>(`/event/${eventKey}/teams/simple`),

  getTeamKeysAtEvent: (eventKey: string): Promise<string[]> =>
    tba.get<string[]>(`/event/${eventKey}/teams/keys`),

  getEventPlayoffAlliances: (
    eventKey: string
  ): Promise<TBAEliminationAlliance[] | null> =>
    tba.get<TBAEliminationAlliance[] | null>(`/event/${eventKey}/alliances`),

  getEventTeamsStatuses: (
    eventKey: string
  ): Promise<TBAEventTeamStatuses> =>
    tba.get<TBAEventTeamStatuses>(`/event/${eventKey}/teams/statuses`),

  getMatch: (matchKey: string): Promise<TBAMatch> =>
    tba.get<TBAMatch>(`/match/${matchKey}`),

  getEventMatches: (eventKey: string): Promise<TBAMatch[]> =>
    tba.get<TBAMatch[]>(`/event/${eventKey}/matches`),

  getEventMatchesSimple: (eventKey: string): Promise<TBAMatchSimple[]> =>
    tba.get<TBAMatchSimple[]>(`/event/${eventKey}/matches/simple`),

  getNextMatch: async (eventKey: string): Promise<TBAMatch | null> => {
    const matches = await TBA.getEventMatches(eventKey);
    const sorted = [...matches].sort(
      (a, b) => (a.predicted_time ?? Infinity) - (b.predicted_time ?? Infinity)
    );

    return sorted.find((match) => match.actual_time == null) ?? null;
  },

  getLastMatch: async (eventKey: string): Promise<TBAMatch | null> => {
    const matches = await TBA.getEventMatches(eventKey);
    let lastMatch: TBAMatch | null = null;
    let bestTime = -Infinity;

    for (const match of matches) {
      if (match.actual_time == null) continue;

      if (match.actual_time > bestTime) {
        bestTime = match.actual_time;
        lastMatch = match;
      }
    }

    return lastMatch;
  },

  getEventRankings: (
    eventKey: string
  ): Promise<TBAEventRanking | null> =>
    tba.get<TBAEventRanking | null>(`/event/${eventKey}/rankings`),

  getEventOPRs: (eventKey: string): Promise<TBAEventOPRs | null> =>
    tba.get<TBAEventOPRs | null>(`/event/${eventKey}/oprs`),

  getDistricts: (year: number): Promise<TBADistrict[]> =>
    tba.get<TBADistrict[]>(`/districts/${year}`),

  getDistrictTeams: (districtKey: string): Promise<TBATeam[]> =>
    tba.get<TBATeam[]>(`/district/${districtKey}/teams`),

  getDistrictTeamKeys: (districtKey: string): Promise<string[]> =>
    tba.get<string[]>(`/district/${districtKey}/teams/keys`),

  getDistrictEvents: (districtKey: string): Promise<TBAEventSimple[]> =>
    tba.get<TBAEventSimple[]>(`/district/${districtKey}/events`),

  getDistrictRankings: (
    districtKey: string
  ): Promise<TBADistrictRanking[]> =>
    tba.get<TBADistrictRanking[]>(`/district/${districtKey}/rankings`),

  getDistrictAdvancement: (
    districtKey: string
  ): Promise<TBADistrictAdvancementResponse> =>
    tba.get<TBADistrictAdvancementResponse>(
      `/district/${districtKey}/advancement`
    ),

  getDistrictTeamsAdvancedToCMP: async (
    districtKey: string
  ) => {
    const advancement = await TBA.getDistrictAdvancement(districtKey);
    const teams = advancement.teams ?? {};

    return Object.entries(teams)
      .filter(([, status]) => status.cmp === true)
      .map(([key, status]) => ({
        key,
        ...status,
        district_key: districtKey,
        district_abbreviation: districtKey.replace(/[0-9]/g, "").toUpperCase(),
      }));
  },

  getAllDistrictTeamsAdvancedToCMP: async (year: number) => {
    const districts = await TBA.getDistricts(year);

    const allCMPTeams = await Promise.all(
      districts.map(async (district) => {
        const advancement = await TBA.getDistrictAdvancement(district.key);
        const teams = advancement.teams ?? {};

        return Object.entries(teams)
          .filter(([, status]) => status.cmp === true)
          .map(([key, status]) => ({
            key,
            ...status,
            district_key: district.key,
            district_abbreviation: district.key
              .replace(/[0-9]/g, "")
              .toUpperCase(),
          }));
      })
    );

    return allCMPTeams.flat();
  },

  getEventWebcasts: async (eventKey: string) => {
    const event = await TBA.getEvent(eventKey);
    return buildStreams(event.webcasts ?? []);
  },
};
