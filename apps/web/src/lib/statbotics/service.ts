import { statbotics } from "./index";
import type { StatboticsMatch, StatboticsTeamEvent, StatboticsTeamYear } from "./types";

export const Statbotics = {
  getMatch: (
    matchKey: string,
    options: { refresh?: boolean } = {},
  ): Promise<StatboticsMatch | null> =>
    statbotics.getMatch(matchKey, options),
  getTeamYear: (team: number, year: number): Promise<StatboticsTeamYear | null> =>
    statbotics.getTeamYear(team, year),
  getTeamEvent: (team: number, eventKey: string, options: { refresh?: boolean } = {}): Promise<StatboticsTeamEvent | null> =>
    statbotics.getTeamEvent(team, eventKey, options),
  getMatches: (filters: { team?: number; year?: number; event?: string; elim?: boolean } = {}, options: { refresh?: boolean } = {}): Promise<StatboticsMatch[]> =>
    statbotics.getMatches(filters, options),
  getTeamEvents: (filters: { team?: number; year?: number; event?: string } = {}, options: { refresh?: boolean } = {}): Promise<StatboticsTeamEvent[]> =>
    statbotics.getTeamEvents(filters, options),
};
