import type {
  TBAEvent,
  TBAEventOPRs,
  TBAEventTeamStatuses,
  TBATeam,
} from "@fieldview/provider-tba/types";
import type { EventKey } from "../ids.js";
import type { FieldViewEventSnapshot } from "../event.js";
import type { FieldViewSourceMetadata } from "../source-metadata.js";
import { normalizeFieldViewEvent } from "./event.ts";
import { normalizeFieldViewEventTeam } from "./event-team.ts";
import { normalizeFieldViewTeam } from "./team.ts";

export interface NormalizeFieldViewEventSnapshotInput {
  event_key: EventKey;
  /** Undefined means not acquired; null is an explicit provider null. */
  tba_event?: TBAEvent | null;
  tba_teams?: TBATeam[] | null;
  tba_team_statuses?: TBAEventTeamStatuses | null;
  tba_event_oprs?: TBAEventOPRs | null;
  sources: {
    event: FieldViewSourceMetadata;
    teams: FieldViewSourceMetadata;
    event_teams: FieldViewSourceMetadata;
  };
}

/** Compose the canonical event, team, and event-team domain objects. */
export function normalizeFieldViewEventSnapshot(
  input: NormalizeFieldViewEventSnapshotInput,
): FieldViewEventSnapshot {
  if (input.tba_event && input.tba_event.key !== input.event_key) {
    throw new Error("TBA event key does not match the requested FieldView event key");
  }
  const result: FieldViewEventSnapshot = { event_key: input.event_key };

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

  return result;
}
