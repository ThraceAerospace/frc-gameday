import type { EventKey, MatchKey, TeamKey } from "./ids.js";

/** Provider-independent competition stage for a match. */
export type FieldViewMatchLevel =
  | "qualification"
  | "octofinal"
  | "quarterfinal"
  | "semifinal"
  | "final";

export interface FieldViewMatchAlliance {
  teamKeys: TeamKey[];
  /** Null means the alliance has no published score. */
  score?: number | null;
}

/** Canonical identity and core result/scheduling data for an FRC match. */
export interface FieldViewMatch {
  /** Canonical TBA key, for example "2026cthar_qm1". */
  key: MatchKey;
  eventKey: EventKey;
  level: FieldViewMatchLevel;
  setNumber: number;
  matchNumber: number;
  alliances?: {
    red: FieldViewMatchAlliance;
    blue: FieldViewMatchAlliance;
  };
  /** ISO-8601 instants; presentation must use the owning event's timezone. */
  scheduledAt?: string | null;
  actualAt?: string | null;
  predictedAt?: string | null;
  postResultAt?: string | null;
}
