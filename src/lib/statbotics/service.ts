import { statbotics } from "./index";
import type { StatboticsMatch } from "./types";

export const Statbotics = {
  getMatch: (
    matchKey: string,
    options: { refresh?: boolean } = {},
  ): Promise<StatboticsMatch | null> =>
    statbotics.getMatch(matchKey, options),
};
