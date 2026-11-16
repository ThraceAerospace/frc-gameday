import type { TeamKey } from "./ids.js";

/** Canonical identity and descriptive information for an FRC team. */
export interface FieldViewTeam {
  /** Canonical TBA key, for example "frc3461". */
  key: TeamKey;
  /** Numeric FRC team number. */
  teamNumber: number;
  /** Official team name, when supplied. */
  name?: string | null;
  /** Common team nickname. */
  nickname?: string | null;
  city?: string | null;
  stateProv?: string | null;
  country?: string | null;
  rookieYear?: number | null;
  website?: string | null;
  schoolName?: string | null;
  motto?: string | null;
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
