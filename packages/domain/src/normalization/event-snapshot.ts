import type {
  TBAEliminationAlliance,
  TBAEvent,
  TBAEventMatchPrediction,
  TBAEventOPRs,
  TBAEventRanking,
  TBAEventAdvancementPoints,
  TBAAward,
  TBAEventPredictions,
  TBAEventTeamStatuses,
  TBAMatch,
  TBATeam,
} from "@fieldview/provider-tba/types";
import type { StatboticsMatch } from "@fieldview/provider-statbotics/types";
import type { EventKey } from "../ids.js";
import type { FieldViewEventSnapshot } from "../event.js";
import type { FieldViewSourceMetadata } from "../source-metadata.js";
import { normalizeFieldViewEvent } from "./event.ts";
import { normalizeFieldViewEventTeam } from "./event-team.ts";
import { normalizeFieldViewMatch } from "./match.ts";
import { normalizeFieldViewPlayoffAlliance } from "./playoff-alliance.ts";
import { normalizeFieldViewTeam } from "./team.ts";
import { sortMatchesByTime } from "../match-order.ts";

export interface NormalizeFieldViewEventSnapshotInput {
  event_key: EventKey;
  /** Undefined means not acquired; null is an explicit provider null. */
  tba_event?: TBAEvent | null;
  tba_teams?: TBATeam[] | null;
  tba_team_statuses?: TBAEventTeamStatuses | null;
  tba_event_oprs?: TBAEventOPRs | null;
  tba_matches?: TBAMatch[] | null;
  tba_event_predictions?: TBAEventPredictions | null;
  tba_playoff_alliances?: TBAEliminationAlliance[] | null;
  tba_event_rankings?: TBAEventRanking | null;
  tba_event_awards?: TBAAward[] | null;
  tba_event_advancement_points?: TBAEventAdvancementPoints | null;
  statbotics_matches?: StatboticsMatch[] | null;
  sources: {
    event: FieldViewSourceMetadata;
    teams: FieldViewSourceMetadata;
    event_teams: FieldViewSourceMetadata;
    matches: FieldViewSourceMetadata;
    playoff_alliances: FieldViewSourceMetadata;
    rankings?: FieldViewSourceMetadata;
    awards?: FieldViewSourceMetadata;
    advancement_points?: FieldViewSourceMetadata;
  };
}

/** Compose the canonical event, team, event-team, match, and playoff objects. */
export function normalizeFieldViewEventSnapshot(
  input: NormalizeFieldViewEventSnapshotInput,
): FieldViewEventSnapshot {
  if (input.tba_event && input.tba_event.key !== input.event_key) {
    throw new Error("TBA event key does not match the requested FieldView event key");
  }
  for (const match of input.tba_matches ?? []) {
    if (match.event_key !== input.event_key) {
      throw new Error("TBA match event key does not match the requested FieldView event key");
    }
  }

  const statboticsMatchesByKey = new Map(
    (input.statbotics_matches ?? []).flatMap((match) =>
      match.key === undefined ? [] : [[match.key, match] as const]),
  );

  const result: FieldViewEventSnapshot = {
    event_key: input.event_key,
    sources: input.sources,
  };

  if (input.tba_event !== undefined) {
    result.event = input.tba_event === null
      ? null
      : normalizeFieldViewEvent(input.tba_event, input.sources.event);
  }

  if (input.tba_teams === null) {
    result.teams = null;
    result.event_teams = null;
  } else if (input.tba_teams !== undefined) {
    result.teams = input.tba_teams.map((team) =>
      normalizeFieldViewTeam(team, input.sources.teams),
    );
    result.event_teams = input.tba_teams.map((team) =>
      normalizeFieldViewEventTeam({
        event_key: input.event_key,
        team_key: team.key,
        ...(input.tba_team_statuses?.[team.key] === undefined
          ? {}
          : { tba_status: input.tba_team_statuses[team.key] }),
        ...(input.tba_event_oprs === undefined || input.tba_event_oprs === null
          ? {}
          : { tba_event_oprs: input.tba_event_oprs }),
        sources: input.sources.event_teams,
      }),
    );
  }

  if (input.tba_event_rankings !== undefined) {
    result.rankings = input.tba_event_rankings;
  }
  if (input.tba_event_awards !== undefined) {
    result.awards = input.tba_event_awards;
  }
  if (input.tba_event_advancement_points !== undefined) {
    result.advancement_points = input.tba_event_advancement_points;
  }

  if (input.tba_playoff_alliances === null) {
    result.playoff_alliances = null;
  } else if (input.tba_playoff_alliances !== undefined) {
    result.playoff_alliances = input.tba_playoff_alliances.map((alliance) =>
      normalizeFieldViewPlayoffAlliance(
        alliance,
        input.event_key,
        input.sources.playoff_alliances,
      ),
    );
  }

  if (input.tba_matches === null) {
    result.matches = null;
  } else if (input.tba_matches !== undefined) {
    const teams = input.tba_teams ?? undefined;
    const eventTeams = input.tba_teams === null
      ? null
      : input.tba_teams === undefined
        ? undefined
        : result.event_teams ?? [];
    const playoffAlliances = input.tba_playoff_alliances === undefined
      ? undefined
      : input.tba_playoff_alliances === null
        ? null
        : result.playoff_alliances ?? [];
    const normalizedMatches = input.tba_matches.map((match) => {
      const prediction: TBAEventMatchPrediction | undefined =
        input.tba_event_predictions?.[match.key];
      return normalizeFieldViewMatch({
        tba_match: match,
        ...(teams === undefined ? {} : { tba_teams: teams }),
        ...(input.tba_event_oprs === undefined || input.tba_event_oprs === null
          ? {}
          : { tba_event_oprs: input.tba_event_oprs }),
        ...(prediction === undefined ? {} : { tba_event_prediction: prediction }),
        ...(statboticsMatchesByKey.get(match.key) === undefined
          ? {}
          : { statbotics_match: statboticsMatchesByKey.get(match.key)! }),
        ...(eventTeams === undefined ? {} : { event_teams: eventTeams }),
        ...(playoffAlliances === undefined ? {} : { tba_playoff_alliances: playoffAlliances }),
        sources: {
          ...(input.sources.matches.tba_match
            ? { tba_match: input.sources.matches.tba_match }
            : {}),
          ...(input.sources.matches.tba_event_predictions
            ? { tba_event_predictions: input.sources.matches.tba_event_predictions }
            : {}),
          ...(input.sources.matches.tba_event_oprs
            ? { tba_event_oprs: input.sources.matches.tba_event_oprs }
            : {}),
          ...(input.sources.matches.tba_team_event_status
            ? { tba_team_event_status: input.sources.matches.tba_team_event_status }
            : {}),
          ...(input.sources.matches.tba_playoff_alliances
            ? { tba_playoff_alliances: input.sources.matches.tba_playoff_alliances }
            : {}),
          ...(input.sources.matches.statbotics_match
            ? { statbotics_match: input.sources.matches.statbotics_match }
            : {}),
        },
      });
    });
    result.matches = sortMatchesByTime(normalizedMatches);
  }

  return result;
}


/** Canonical state naming; the snapshot alias remains during frontend migration. */
export type NormalizeFieldViewEventStateInput = NormalizeFieldViewEventSnapshotInput;
export const normalizeFieldViewEventState = normalizeFieldViewEventSnapshot;
