import { get } from "http";
import { tba } from "./tba";

function getWeekRange(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  // Sunday as start of week (JS default)
  start.setDate(start.getDate() - start.getDay());

  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

function isEventThisWeek(event: any, weekStart: Date, weekEnd: Date) {
  const start = new Date(event.start_date);
  const end = new Date(event.end_date);

  return start <= weekEnd && end >= weekStart;
}

export const TBA = {
  // 👤 Teams
  getTeam: (teamKey: string) =>
    tba.get(`/team/${teamKey}`),

  getTeamEvents: (teamKey: string, year: number) =>
    tba.get(`/team/${teamKey}/events/${year}`),

  getTeamEventStatus: (teamKey: string, eventKey: string) =>
    tba.get(`/team/${teamKey}/event/${eventKey}/status`),

  getTeamMatches: (teamKey: string, eventKey: string) =>
    tba.get(`/team/${teamKey}/event/${eventKey}/matches`),

  getTeamMatchesSimple: (teamKey: string, eventKey: string) =>
    tba.get(`/team/${teamKey}/event/${eventKey}/matches/simple`),

  // 📅 Events
  getEvent: (eventKey: string) =>
    tba.get(`/event/${eventKey}`),

  getEventSimple: (eventKey: string) =>
    tba.get(`/event/${eventKey}/simple`),

  getEvents: (year: number) =>
  tba.get(`/events/${year}`),

  getEventsSimple: (year:number) =>
    tba.get(`/events/${year}/simple`),

  getActiveEvents: async (year: number) => {
    const events:any = await TBA.getEvents(year);

    const { start, end } = getWeekRange();

    return events.filter((e: any) =>
      isEventThisWeek(e, start, end)
    );
  },

  getActiveEventsWithTeams: async (year: number) => {
    const activeEvents = await TBA.getActiveEvents(year);

    const results = await Promise.all(
      activeEvents.map(async (event: any) => {
        const teams = await TBA.getTeamsAtEvent(event.key);

        return {
          ...event,
          teams,
        };
      })
    );

    return results;
  },

  getActiveEventsWithMatches: async (year: number) => {
    const events:any = await TBA.getEvents(year);

    const now = new Date();

    const candidates = events.filter((e: any) => {
      const start = new Date(e.start_date);
      const end = new Date(e.end_date);
      return start <= now && now <= end;
    });

    const enriched = await Promise.all(
      candidates.map(async (event: any) => {
        const matches:any = await TBA.getEventMatchesSimple(event.key);

        const hasStarted = matches.some((m: any) => m.actual_time !== null);

        return hasStarted ? event : null;
      })
    );

    return enriched.filter(Boolean);
  },

  getActiveEventsFull: async (year: number) => {
    const events = await TBA.getActiveEventsWithMatches(year);

    return Promise.all(
      events.map(async (event: any) => {
        const [teams, matches] = await Promise.all([
          TBA.getTeamsAtEvent(event.key),
          TBA.getEventMatchesSimple(event.key),
        ]);

        return {
          ...event,
          teams,
          matches, // optional but VERY useful later
        };
      })
    );
  },

  getTeamsAtEvent: (eventKey: string) =>
    tba.get(`/event/${eventKey}/teams/simple`),
  
  getTeamKeysAtEvent: (eventKey: string) =>
    tba.get(`/event/${eventKey}/teams/keys`),
  
  getEventPlayoffAlliances: (eventKey: string) =>
    tba.get(`/event/${eventKey}/alliances`),

  // 🤖 Matches
  getEventMatches: (eventKey: string) =>
    tba.get(`/event/${eventKey}/matches`),

  getEventMatchesSimple: (eventKey: string) =>
    tba.get(`/event/${eventKey}/matches/simple`),

  // 📺 Webcasts
  getEventWebcasts: (eventKey: string) =>
    tba.get(`/event/${eventKey}/webcasts`),
};