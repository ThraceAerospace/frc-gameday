import { get } from "http";
import { tba } from "./tba";

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

  getTeamsAtEvent: (eventKey: string) =>
    tba.get(`/event/${eventKey}/teams/simple`),

  // 🤖 Matches
  getEventMatches: (eventKey: string) =>
    tba.get(`/event/${eventKey}/matches`),

  getEventMatchesSimple: (eventKey: string) =>
    tba.get(`/event/${eventKey}/matches/simple`),

  // 📺 Webcasts
  getEventWebcasts: (eventKey: string) =>
    tba.get(`/event/${eventKey}/webcasts`),
};