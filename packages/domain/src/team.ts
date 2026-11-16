import type { TBATeam } from "@fieldview/provider-tba/types";
import type { TeamKey } from "./ids.js";

/** Canonical identity and descriptive information for an FRC team. */
export interface FieldViewTeam {
  /** Canonical TBA key, validated and branded at the provider boundary. */
  key: TeamKey;
  /** Numeric FRC team number. */
  teamNumber: TBATeam["team_number"];
  /** Official team name, when supplied. */
  name?: TBATeam["name"] | null;
  /** Common team nickname. */
  nickname?: TBATeam["nickname"] | null;
  city?: TBATeam["city"];
  stateProv?: TBATeam["state_prov"];
  country?: TBATeam["country"];
  rookieYear?: TBATeam["rookie_year"];
  website?: TBATeam["website"];
  schoolName?: TBATeam["school_name"];
  motto?: TBATeam["motto"];
}

/**
 * A team's season-scoped identity.
 *
 * Season metrics and event participation do not belong here; those are
 * separate aggregates with their own lifecycle and provider enrichment.
 */
export interface FieldViewTeamSeason {
  teamKey: TeamKey;
  year: number;
}
