import type { EventKey, TeamKey } from "../ids.js";
import type { FieldViewEventTeam } from "../event.js";
import type { FieldViewMatch } from "../match.js";
import type { FieldViewSourceMetadata } from "../source-metadata.js";
import type { FieldViewTeam, FieldViewTeamEventState } from "../team.js";
import type { FieldViewTeamEventAnalytics } from "../analytics.js";

export interface NormalizeFieldViewTeamEventStateInput {
  event_key: EventKey;
  team_key: TeamKey;
  sources: FieldViewTeamEventState["sources"];
  team?: FieldViewTeam | null;
  event_team?: FieldViewEventTeam | null;
  matches?: FieldViewMatch[] | null;
  analytics?: FieldViewTeamEventAnalytics | null;
}

/**
 * Assemble the event-scoped view of a team without recalculating analytics.
 * The supplied match list must contain only matches in which the team appears.
 */
export function normalizeFieldViewTeamEventState(
  input: NormalizeFieldViewTeamEventStateInput,
): FieldViewTeamEventState {
  if (input.event_team && (
    input.event_team.event_key !== input.event_key ||
    input.event_team.team_key !== input.team_key
  )) {
    throw new Error("Event-team association does not match the requested team state");
  }
  for (const match of input.matches ?? []) {
    if (match.event_key !== input.event_key) {
      throw new Error("Match event key does not match the requested team state");
    }
    const appears = match.alliances.red.team_keys.includes(input.team_key) ||
      match.alliances.blue.team_keys.includes(input.team_key);
    if (!appears) {
      throw new Error("Team state contains a match in which the team did not appear");
    }
  }
  if (input.analytics && (
    input.analytics.event_key !== input.event_key ||
    input.analytics.team_key !== input.team_key
  )) {
    throw new Error("Team analytics do not match the requested team state");
  }

  return {
    event_key: input.event_key,
    team_key: input.team_key,
    sources: input.sources,
    ...(input.team === undefined ? {} : { team: input.team }),
    ...(input.event_team === undefined ? {} : { event_team: input.event_team }),
    ...(input.matches === undefined ? {} : { matches: input.matches }),
    ...(input.analytics === undefined ? {} : { analytics: input.analytics }),
  };
}
