import type { EventKey, TeamKey } from "./ids.js";

/** A versioned metric result with its eligible population and coverage. */
export interface FieldViewMetricResult {
  metric_key: string;
  definition_version: string;
  value: number | null;
  unit: string;
  sample_size: number;
  eligible_population: number;
  comparison_coverage: {
    eligible: number;
    total: number;
  };
}

/** Event-wide analytics results; calculations are performed server-side. */
export interface FieldViewEventAnalytics {
  event_key: EventKey;
  metrics: FieldViewMetricResult[];
}

/** Team-specific and historical analytics results. */
export interface FieldViewTeamAnalytics {
  team_key: TeamKey;
  metrics: FieldViewMetricResult[];
}
