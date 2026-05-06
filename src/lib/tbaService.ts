import { tba } from "./tba";
import { buildStreams } from "@/lib/gameday/buildStreams";

/* -------------------------- */
/* 🧠 Helpers                 */
/* -------------------------- */

function parseDate(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
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

function isEventThisWeek(event: any, weekStart: Date, weekEnd: Date) {
  const start = parseDate(event.start_date);
  const end = parseDate(event.end_date);
  return start <= weekEnd && end >= weekStart;
}

function isMatchPlayed(match: any) {
  return match?.actual_time != null;
}

/* -------------------------- */
/* 🚀 Service                 */
/* -------------------------- */

export const TBA = {
  /* ------------------ */
  /* 👤 Teams            */
  /* ------------------ */

  getTeam: (teamKey: string) =>
    tba.get(`/team/${teamKey}`, 86400),

  getTeamDistricts: (teamKey: string) =>
    tba.get(`/team/${teamKey}/districts`, 86400),

  getTeamEvents: (teamKey: string, year: number) =>
    tba.get(`/team/${teamKey}/events/${year}`, 86400),

  getTeamEventStatus: (teamKey: string, eventKey: string) =>
    tba.get(`/team/${teamKey}/event/${eventKey}/status`, 30),

  getTeamMatches: (teamKey: string, eventKey: string) =>
    tba.get(`/team/${teamKey}/event/${eventKey}/matches`, 15, {
      noStore: true,
    }),

  getTeamMatchesSimple: (teamKey: string, eventKey: string) =>
    tba.get(`/team/${teamKey}/event/${eventKey}/matches/simple`, 15, {
      noStore: true,
    }),

  /* ------------------ */
  /* 📅 Events           */
  /* ------------------ */

  getEvent: (eventKey: string) =>
    tba.get(`/event/${eventKey}`, 86400),

  getEventSimple: (eventKey: string) =>
    tba.get(`/event/${eventKey}/simple`, 86400),

  getEvents: (year: number) =>
    tba.get(`/events/${year}`, 86400),

  getEventsSimple: (year: number) =>
    tba.get(`/events/${year}/simple`, 86400),

  /* ------------------ */
  /* 🔍 Derived Events   */
  /* ------------------ */

  getActiveEvents: async (year: number) => {
    const events = (await TBA.getEvents(year)) as any[];

    const { start, end } = getWeekRange();

    return events.filter((e) =>
      isEventThisWeek(e, start, end)
    );
  },

  getActiveEventsWithTeams: async (year: number) => {
    const activeEvents = await TBA.getActiveEvents(year);

    return Promise.all(
      activeEvents.map(async (event: any) => {
        const teams = await TBA.getTeamsAtEvent(event.key);

        return {
          ...event,
          teams,
        };
      })
    );
  },

  getActiveEventsWithMatches: async (year: number) => {
    const events = (await TBA.getEvents(year)) as any[];

    const now = new Date();

    const candidates = events.filter((e) => {
      const start = parseDate(e.start_date);
      const end = parseDate(e.end_date);
      return start <= now && now <= end;
    });

    const enriched = await Promise.all(
      candidates.map(async (event: any) => {
        const matches = (await TBA.getEventMatchesSimple(event.key)) as any[];

        const hasPlayedMatches = matches.some(isMatchPlayed);

        return hasPlayedMatches ? event : null;
      })
    );

    return enriched.filter(Boolean);
  },

  getActiveEventsFull: async (year: number) => {
    const events = await TBA.getActiveEventsWithMatches(year);

    return Promise.all(
      events
        .filter(Boolean)
        .map(async (event: any) => {
          const [teams, matches] = await Promise.all([
            TBA.getTeamsAtEvent(event.key),
            TBA.getEventMatchesSimple(event.key),
          ]);

          const hasDivisions = (event.division_keys?.length ?? 0) > 0;
          const hasMatches = matches.length > 0;
          const hasPlayedMatches = matches.some(isMatchPlayed);

          const now = new Date();
          const start = parseDate(event.start_date);

          const isPastStart = now >= start;

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

  /* ------------------ */
  /* 🧍 Event Teams      */
  /* ------------------ */

  getTeamsAtEvent: (eventKey: string) =>
    tba.get(`/event/${eventKey}/teams`, 86400),

  getTeamsAtEventSimple: (eventKey: string) =>
    tba.get(`/event/${eventKey}/teams/simple`, 86400),

  getTeamKeysAtEvent: (eventKey: string) =>
    tba.get(`/event/${eventKey}/teams/keys`, 86400),

  getEventPlayoffAlliances: (eventKey: string) =>
    tba.get(`/event/${eventKey}/alliances`, 300),

  getEventTeamsStatuses: (eventKey: string) =>
    tba.get(`/event/${eventKey}/teams/statuses`, 30),

  /* ------------------ */
  /* 🤖 Matches          */
  /* ------------------ */

  getMatch: (matchKey: string) =>
    tba.get(`/match/${matchKey}`, 0, {
      noStore: true,
    }),

  getEventMatches: (eventKey: string) =>
    tba.get(`/event/${eventKey}/matches`, 15, {
      noStore: true,
    }),

  getEventMatchesSimple: (eventKey: string) =>
    tba.get(`/event/${eventKey}/matches/simple`, 15, {
      noStore: true,
    }),
  
  getEventMatchesSimpleNoCache: (eventKey: string) =>
    tba.get(`/event/${eventKey}/matches/simple`, 0, {
      noStore: true,
    }),

  /* ------------------ */
  /* 🏆 Districts        */
  /* ------------------ */

  getDistricts: (year: number) =>
    tba.get(`/districts/${year}`, 86400),

  getDistrictTeams: (districtKey: string) =>
    tba.get(`/district/${districtKey}/teams`, 86400),

  getDistrictTeamKeys: (districtKey: string) =>
    tba.get(`/district/${districtKey}/teams/keys`, 86400),

  getDistrictEvents: (districtKey: string) =>
    tba.get(`/district/${districtKey}/events`, 86400),

  getDistrictRankings: (districtKey: string) =>
    tba.get(`/district/${districtKey}/rankings`, 86400),

  getDistrictAdvancement: (districtKey: string) =>
    tba.get(`/district/${districtKey}/advancement`, 86400),

  getDistrictTeamsAdvancedToCMP: async (districtKey: string) => {
    const advancement = await tba.get(
      `/district/${districtKey}/advancement`,
      86400
    );

    return Object.entries(advancement)
      .filter(([, t]: any) => t.cmp === true)
      .map(([key, t]: any) => ({
        key,
        ...t,
        district_key: districtKey,
        district_abbreviation: districtKey.replace(/[0-9]/g, "").toUpperCase(),
      }));
  },

  getAllDistrictTeamsAdvancedToCMP: async (year: number) => {
    const districts = await tba.get(`/districts/${year}`, 86400);

    const allCMPTeams = await Promise.all(
      districts.map((d: any) =>
        tba
          .get(`/district/${d.key}/advancement`, 86400)
          .then((advancement: any) =>
            Object.entries(advancement)
              .filter(([, t]: any) => t.cmp === true)
              .map(([key, t]: any) => ({
                key,
                ...t,
                district_key: d.key,
                district_abbreviation: d.key.replace(/[0-9]/g, "").toUpperCase(),
              }))
          )
      )
    );

    return allCMPTeams.flat();
  },

  /* ------------------ */
  /* 📺 Webcasts         */
  /* ------------------ */

  getEventWebcasts: (eventKey: string) =>
    tba.get(`/event/${eventKey}`, 86400).then(async (e: any) => {
      return buildStreams(e.webcasts);
    }),
};