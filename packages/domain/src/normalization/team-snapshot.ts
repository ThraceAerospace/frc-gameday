import type { TBADistrict, TBAMedia, TBAEvent, TBATeam } from "@fieldview/provider-tba/types";
import type { FieldViewTeamSnapshot } from "../team.js";
import type { TeamKey } from "../ids.js";
import type { FieldViewSourceMetadata } from "../source-metadata.js";
import { normalizeFieldViewTeam } from "./team.ts";

export interface NormalizeFieldViewTeamSnapshotInput {
  team_key: TeamKey;
  year: number;
  sources: FieldViewSourceMetadata;
  team?: TBATeam | null;
  districts?: TBADistrict[] | null;
  events?: TBAEvent[] | null;
  media?: TBAMedia[] | null;
}

/** Compose team-scoped resources without renaming or rewriting provider fields. */
export function normalizeFieldViewTeamSnapshot(input: NormalizeFieldViewTeamSnapshotInput): FieldViewTeamSnapshot {
  return {
    team_key: input.team_key,
    year: input.year,
    sources: input.sources,
    ...(input.team === undefined ? {} : {
      team: input.team === null ? null : normalizeFieldViewTeam(input.team, {
        ...(input.sources.tba_team === undefined ? {} : { tba_team: input.sources.tba_team }),
      }),
    }),
    ...(input.districts === undefined ? {} : { districts: input.districts }),
    ...(input.events === undefined ? {} : { events: input.events }),
    ...(input.media === undefined ? {} : { media: input.media }),
  };
}
