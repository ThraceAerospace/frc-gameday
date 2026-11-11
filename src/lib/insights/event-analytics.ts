import type { EventAnalyticsResponse } from "./types";

/**
 * Source lifecycle state exposed by the EventAnalytics contract.
 *
 * "pending" means acquisition has not completed yet. "unavailable" means an
 * acquisition was attempted but produced no usable source data. "partial"
 * means some, but not all, expected records are available. "unknown" means a
 * legacy persisted snapshot predates per-resource acquisition tracking.
 */
export type EventAnalyticsSourceStatus =
  | "pending"
  | "ready"
  | "partial"
  | "unavailable"
  | "unknown";

export type EventAnalyticsSource = {
  status: EventAnalyticsSourceStatus;
  /** Unix timestamp in milliseconds for the latest successful acquisition. */
  updatedAt: number | null;
  /** Provider error, when available. Never required for a usable snapshot. */
  error?: string | null;
};

export type EventAnalyticsTbaResources = {
  event: EventAnalyticsSource;
  teams: EventAnalyticsSource;
  matches: EventAnalyticsSource;
  oprs: EventAnalyticsSource;
  rankings: EventAnalyticsSource;
  playoffAlliances: EventAnalyticsSource;
};

export type EventAnalyticsTbaSource = EventAnalyticsSource & {
  resources: EventAnalyticsTbaResources;
};

/**
 * The versioned, provider-aware analytics contract returned to FieldView
 * consumers. Existing analytics fields remain intact for compatibility while
 * the envelope makes identity, freshness, and provenance explicit.
 *
 * Timestamps in this contract are Unix milliseconds, matching the existing
 * analytics collection metadata.
 */
export type EventAnalytics = EventAnalyticsResponse & {
  schemaVersion: 1;
  eventKey: string;
  generatedAt: number;
  provenance: {
    event: "tba";
    teams: "tba";
    matches: "tba";
    rankings: "tba";
    oprs: "tba";
    playoffAlliances: "tba";
    statboticsMatches: "statbotics";
    teamColors: "frc-colors";
    derived: "fieldview";
  };
  sources: {
    tba: EventAnalyticsTbaSource;
    statbotics: EventAnalyticsSource;
    frcColors: EventAnalyticsSource;
  };
};
