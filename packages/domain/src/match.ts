import type { TBAMatch } from "@fieldview/provider-tba/types";
import type { EventKey, MatchKey, TeamKey } from "./ids.js";

/** Provider-normalized competition stage for a match. */
export type FieldViewMatchLevel =
  | "qualification"
  | "octofinal"
  | "quarterfinal"
  | "semifinal"
  | "final";

export interface FieldViewMatchAlliance {
  /** Team identifiers are validated and branded at the provider boundary. */
  teamKeys: TeamKey[];
  /** Null means the alliance has no published score. */
  score?: TBAMatch["alliances"]["red"]["score"] | null;
}

/** Canonical identity and core result/scheduling data for an FRC match. */
export interface FieldViewMatch {
  /** Canonical TBA key, validated and branded at the provider boundary. */
  key: MatchKey;
  eventKey: EventKey;
  level: FieldViewMatchLevel;
  setNumber: TBAMatch["set_number"];
  matchNumber: TBAMatch["match_number"];
  alliances?: {
    red: FieldViewMatchAlliance;
    blue: FieldViewMatchAlliance;
  };
  /** Normalized ISO-8601 instants; presentation must use the owning event's timezone. */
  scheduledAt?: string | null;
  actualAt?: string | null;
  predictedAt?: string | null;
  postResultAt?: string | null;
}
