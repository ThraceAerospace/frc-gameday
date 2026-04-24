import { tba } from "./tba";
import {buildStreams} from "@/lib/gameday/buildStreams"
/* -------------------------- */
/* 🧠 Helpers                 */
/* -------------------------- */

// ✅ Fix timezone issues (no UTC shifting)
function parseDate(dateStr: { split: (arg0: string) => { (): any; new(): any; map: { (arg0: NumberConstructor): [any, any, any]; new(): any; }; }; }) {
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

function isEventThisWeek(event: { start_date: any; end_date: any; }, weekStart: number | Date, weekEnd: number | Date) {
  const start = parseDate(event.start_date);
  const end = parseDate(event.end_date);

  return start <= weekEnd && end >= weekStart;
}

function isMatchPlayed(match: { actual_time: null; }) {
  return match?.actual_time != null;
}

/* -------------------------- */
/* 🚀 Service                 */
/* -------------------------- */

export const TBA = {
  /* ------------------ */
  /* 👤 Teams            */
  /* ------------------ */

  getTeam: (teamKey: any) =>
    tba.get(`/team/${teamKey}`, 86400),

  getTeamEvents: (teamKey: any, year: any) =>
    tba.get(`/team/${teamKey}/events/${year}`, 86400),

  getTeamEventStatus: (teamKey: any, eventKey: any) =>
    tba.get(`/team/${teamKey}/event/${eventKey}/status`, 30),

  getTeamMatches: (teamKey: any, eventKey: any) =>
    tba.get(`/team/${teamKey}/event/${eventKey}/matches`, 30),

  getTeamMatchesSimple: (teamKey: any, eventKey: any) =>
    tba.get(`/team/${teamKey}/event/${eventKey}/matches/simple`, 30),

  /* ------------------ */
  /* 📅 Events           */
  /* ------------------ */

  getEvent: (eventKey: any) =>
    tba.get(`/event/${eventKey}`, 86400),

  getEventSimple: (eventKey: any) =>
    tba.get(`/event/${eventKey}/simple`, 86400),

  getEvents: (year: any) =>
    tba.get(`/events/${year}`, 86400),

  getEventsSimple: (year: any) =>
    tba.get(`/events/${year}/simple`, 86400),

  /* ------------------ */
  /* 🔍 Derived Events   */
  /* ------------------ */

  getActiveEvents: async (year: any) => {
    const events = await TBA.getEvents(year) as any[];

    const { start, end } = getWeekRange();

    return events.filter((e: any) =>
      isEventThisWeek(e, start, end)
    );
  },

  getActiveEventsWithTeams: async (year: any) => {
    const activeEvents = await TBA.getActiveEvents(year);

    return Promise.all(
      activeEvents.map(async (event: { key: any; }) => {
        const teams = await TBA.getTeamsAtEvent(event.key);

        return {
          ...event,
          teams,
        };
      })
    );
  },

  getActiveEventsWithMatches: async (year: any) => {
    const events = await TBA.getEvents(year) as any[];

    const now = new Date();

    const candidates = events.filter((e: { start_date: any; end_date: any; }) => {
      const start = parseDate(e.start_date);
      const end = parseDate(e.end_date);

      return start <= now && now <= end;
    });

    const enriched = await Promise.all(
      candidates.map(async (event: any) => {
        const matches = await TBA.getEventMatchesSimple(event.key) as any[];

        const hasPlayedMatches = matches.some(isMatchPlayed);

        return hasPlayedMatches ? event : null;
      })
    );

    return enriched.filter(Boolean);
  },

  getActiveEventsFull: async (year: any) => {
    const events = await TBA.getActiveEventsWithMatches(year);

    return Promise.all(
      events.filter(Boolean).map(async (event: { key: any; division_keys: string | any[]; start_date: any; }) => {
        const [teams, matches] = await Promise.all([
          TBA.getTeamsAtEvent(event.key), 
          TBA.getEventMatchesSimple(event.key), 
        ]) as [any[], any[]];

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

  getTeamsAtEvent: (eventKey: any) =>
    tba.get(`/event/${eventKey}/teams`, 86400),

  getTeamsAtEventSimple: (eventKey: any) =>
    tba.get(`/event/${eventKey}/teams/simple`, 86400),

  getTeamKeysAtEvent: (eventKey: any) =>
    tba.get(`/event/${eventKey}/teams/keys`, 86400),

  getEventPlayoffAlliances: (eventKey: any) =>
    tba.get(`/event/${eventKey}/alliances`, 300),

  getEventTeamsStatuses: (eventKey:any) =>
    tba.get(`/event/${eventKey}/teams/statuses`, 300),

  /* ------------------ */
  /* 🤖 Matches          */
  /* ------------------ */

  getEventMatches: (eventKey: any) =>
    tba.get(`/event/${eventKey}/matches`, 30),

  getEventMatchesSimple: (eventKey: any) =>
    tba.get(`/event/${eventKey}/matches/simple`, 30),

  /* ------------------ */
  /* 📺 Webcasts         */
  /* ------------------ */

  getEventWebcasts: (eventKey: any) =>
    tba.get(`/event/${eventKey}`, 86400).then(async (e) => {
      const normalized = await buildStreams(e.webcasts)
      return normalized;
    }),
};