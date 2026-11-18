import type { TBADistrict, TBAMedia, TBAEvent, TBATeam } from "@fieldview/provider-tba/types";
import type { StatboticsTeamYear } from "@fieldview/provider-statbotics/types";
import type { TeamKey } from "./ids.js";
import type { FieldViewSourceMetadata } from "./source-metadata.js";

/** Canonical FieldView team object; TBA fields retain their exact source shape. */
export interface FieldViewTeam extends TBATeam {
  sources: FieldViewSourceMetadata;
}

/** Canonical team profile composed from independently acquired TBA resources. */
export interface FieldViewTeamSnapshot {
  team_key: TeamKey;
  year: number;
  sources: FieldViewSourceMetadata;
  team?: FieldViewTeam | null;
  districts?: TBADistrict[] | null;
  events?: TBAEvent[] | null;
  media?: TBAMedia[] | null;
}

/** A team's season-scoped Statbotics record correlated by official TBA team number. */
export interface FieldViewTeamSeason {
  team_key: TeamKey;
  year: number;
  team_number: TBATeam["team_number"];
  statbotics?: StatboticsTeamYear;
  sources: FieldViewSourceMetadata;
}
