import { tba } from "./index";
import { buildStreams } from "@/lib/tba/buildStreams";
import { TBA_ENDPOINTS } from "@fieldview/provider-tba/endpoints";
import type {
  TBAEliminationAlliance,
  TBAEvent,
  TBAEventSimple,
  TBAEventTeamStatuses,
  TBAEventWithMatches,
  TBAEventWithTeams,
  TBAEventOPRs,
  TBAEventRanking,
  TBAEventAdvancementPoints,
  TBAAward,
  TBAMedia,
  TBATeamAvatar,
  TBADistrict,
  TBADistrictAdvancementMap,
  TBADistrictAdvancementResponse,
  TBADistrictRanking,
  TBAMatch,
  TBAMatchSimple,
  TBATeam,
  TBATeamEventStatus,
  TBATeamSimple,
} from "@/lib/tba/types";

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
    tba.get<TBATeam>(TBA_ENDPOINTS.team(teamKey)),

  getTeamAvatar: async (
    teamKey: string,
    year: number,
  ): Promise<TBATeamAvatar | null> => {
    const media = await tba.get<TBAMedia[]>(TBA_ENDPOINTS.teamMedia(teamKey, year));
    return media.find((item): item is TBATeamAvatar => item.type === "avatar") ?? null;
  },

  getTeams: (year: number): Promise<TBATeam[]> =>
    tba.get<TBATeam[]>(TBA_ENDPOINTS.teams(year)),

  getTeamDistricts: (teamKey: string): Promise<TBADistrict[]> =>
    tba.get<TBADistrict[]>(TBA_ENDPOINTS.teamDistricts(teamKey)),

  getTeamEvents: (teamKey: string, year: number): Promise<TBAEvent[]> =>
    tba.get<TBAEvent[]>(TBA_ENDPOINTS.teamEvents(teamKey, year)),

  getTeamEventStatus: (
    teamKey: string,
    eventKey: string
  ): Promise<TBATeamEventStatus | null> =>
    tba.get<TBATeamEventStatus | null>(
      TBA_ENDPOINTS.teamEventStatus(teamKey, eventKey)
    ),

  getTeamEventAwards: (
    teamKey: string,
    eventKey: string
  ): Promise<TBAAward[]> =>
    tba.get<TBAAward[]>(TBA_ENDPOINTS.teamEventAwards(teamKey, eventKey)),

  getTeamMatches: (
    teamKey: string,
    eventKey: string
  ): Promise<TBAMatch[]> =>
    tba.get<TBAMatch[]>(TBA_ENDPOINTS.teamEventMatches(teamKey, eventKey)),

  getTeamMatchesSimple: (
    teamKey: string,
    eventKey: string
  ): Promise<TBAMatchSimple[]> =>
    tba.get<TBAMatchSimple[]>(
      TBA_ENDPOINTS.teamEventMatchesSimple(teamKey, eventKey)
    ),

  getEvent: (eventKey: string): Promise<TBAEvent> =>
    tba.get<TBAEvent>(TBA_ENDPOINTS.event(eventKey)),

  getEventSimple: (eventKey: string): Promise<TBAEventSimple> =>
    tba.get<TBAEventSimple>(TBA_ENDPOINTS.eventSimple(eventKey)),

  getEventAdvancementPoints: (
    eventKey: string
  ): Promise<TBAEventAdvancementPoints | null> =>
    tba.get<TBAEventAdvancementPoints | null>(
      TBA_ENDPOINTS.eventAdvancementPoints(eventKey)
    ),

  getEvents: (year: number): Promise<TBAEvent[]> =>
    tba.get<TBAEvent[]>(TBA_ENDPOINTS.events(year)),

  getEventsSimple: (year: number): Promise<TBAEventSimple[]> =>
    tba.get<TBAEventSimple[]>(TBA_ENDPOINTS.eventsSimple(year)),

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

  getTeamsAtEvent: (eventKey: string): Promise<TBATeam[]> =>
    tba.get<TBATeam[]>(TBA_ENDPOINTS.eventTeams(eventKey)),

  getTeamsAtEventSimple: (eventKey: string): Promise<TBATeamSimple[]> =>
    tba.get<TBATeamSimple[]>(TBA_ENDPOINTS.eventTeamsSimple(eventKey)),

  getTeamKeysAtEvent: (eventKey: string): Promise<string[]> =>
    tba.get<string[]>(TBA_ENDPOINTS.eventTeamKeys(eventKey)),

  getEventPlayoffAlliances: (
    eventKey: string
  ): Promise<TBAEliminationAlliance[] | null> =>
    tba.get<TBAEliminationAlliance[] | null>(TBA_ENDPOINTS.eventAlliances(eventKey)),

  getEventTeamsStatuses: (
    eventKey: string
  ): Promise<TBAEventTeamStatuses> =>
    tba.get<TBAEventTeamStatuses>(TBA_ENDPOINTS.eventTeamStatuses(eventKey)),

  getMatch: (matchKey: string): Promise<TBAMatch> =>
    tba.get<TBAMatch>(TBA_ENDPOINTS.match(matchKey)),

  getEventMatches: (eventKey: string): Promise<TBAMatch[]> =>
    tba.get<TBAMatch[]>(TBA_ENDPOINTS.eventMatches(eventKey)),

  getEventMatchesSimple: (eventKey: string): Promise<TBAMatchSimple[]> =>
    tba.get<TBAMatchSimple[]>(TBA_ENDPOINTS.eventMatchesSimple(eventKey)),

  getNextMatch: async (eventKey: string): Promise<TBAMatch | null> => {
    const matches = await TBA.getEventMatches(eventKey);
    const sorted = [...matches].sort(
      (a, b) =>
        (a.predicted_time ?? a.time ?? Infinity) -
        (b.predicted_time ?? b.time ?? Infinity)
    );

    return (
      sorted.find(
        (match) =>
          match.alliances.red.score === -1 ||
          match.alliances.blue.score === -1,
      ) ?? null
    );
  },

  getLastMatch: async (eventKey: string): Promise<TBAMatch | null> => {
    const matches = await TBA.getEventMatches(eventKey);
    let lastMatch: TBAMatch | null = null;
    let bestTime = -Infinity;

    for (const match of matches) {
      const hasPostedScore =
        match.alliances.red.score != null &&
        match.alliances.red.score >= 0 &&
        match.alliances.blue.score != null &&
        match.alliances.blue.score >= 0;

      if (!hasPostedScore) continue;

      const time =
        match.actual_time ??
        match.predicted_time ??
        match.time ??
        -Infinity;

      if (time > bestTime) {
        bestTime = time;
        lastMatch = match;
      }
    }

    return lastMatch;
  },

  getEventRankings: (
    eventKey: string
  ): Promise<TBAEventRanking | null> =>
    tba.get<TBAEventRanking | null>(TBA_ENDPOINTS.eventRankings(eventKey)),

  getEventOPRs: (eventKey: string): Promise<TBAEventOPRs | null> =>
    tba.get<TBAEventOPRs | null>(TBA_ENDPOINTS.eventOPRs(eventKey)),

  getDistricts: (year: number): Promise<TBADistrict[]> =>
    tba.get<TBADistrict[]>(TBA_ENDPOINTS.districts(year)),

  getDistrictTeams: (districtKey: string): Promise<TBATeam[]> =>
    tba.get<TBATeam[]>(TBA_ENDPOINTS.districtTeams(districtKey)),

  getDistrictTeamKeys: (districtKey: string): Promise<string[]> =>
    tba.get<string[]>(TBA_ENDPOINTS.districtTeamKeys(districtKey)),

  getDistrictEvents: (districtKey: string): Promise<TBAEventSimple[]> =>
    tba.get<TBAEventSimple[]>(TBA_ENDPOINTS.districtEvents(districtKey)),

  getDistrictRankings: (
    districtKey: string
  ): Promise<TBADistrictRanking[]> =>
    tba.get<TBADistrictRanking[]>(TBA_ENDPOINTS.districtRankings(districtKey)),

  getDistrictAdvancement: (
    districtKey: string
  ): Promise<TBADistrictAdvancementResponse> =>
    tba.get<TBADistrictAdvancementResponse>(
      TBA_ENDPOINTS.districtAdvancement(districtKey)
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
