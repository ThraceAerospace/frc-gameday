import type { EventKey, TeamKey } from "./ids.js";

/**
 * Describes the population from which a metric's observations were drawn.
 * Counts are explicit so consumers never infer missing observations from a
 * sample size or treat unavailable records as zero.
 */
export interface FieldViewAnalyticsPopulation {
  /** Stable, documented identity for this population (for example, "event-quals"). */
  population_key: string;
  /** Number of observations/subjects expected in the defined population. */
  total_count: number;
  /** Number eligible under the metric definition's inclusion rules. */
  eligible_count: number;
  /** Number excluded by those rules; total = eligible + excluded. */
  excluded_count: number;
}

/** A prior-period value used as the baseline for a change metric. */
export interface FieldViewAnalyticsBaseline {
  kind: "prior-event";
  event_key: EventKey;
  event_name: string;
  event_start_date: string;
  value: number;
}

/** A rank/percentile within an explicitly identified comparison population. */
export interface FieldViewAnalyticsComparison {
  population: FieldViewAnalyticsPopulation;
  /** One-based rank; null when the comparison cannot be ranked reliably. */
  rank_position: number | null;
  /** 0–100 percentile; null when the cohort is too small to support one. */
  percentile: number | null;
}

/**
 * A calculated metric with separate observation and peer-comparison coverage.
 *
 * sample_size is the number of observations used to calculate value.
 * population describes the observation population. comparison, when present,
 * describes a different population used for rank/peer context.
 */
interface FieldViewMetricResultBase {
  metric_key: string;
  definition_version: string;
  unit: string;
  sample_size: number;
  population: FieldViewAnalyticsPopulation;
  comparison?: FieldViewAnalyticsComparison;
  /** Present only when this metric is explicitly a change from a prior event. */
  baseline?: FieldViewAnalyticsBaseline;
  /** Caveats that qualify interpretation; never inferred by the client. */
  limitations: string[];
}

/** Discriminated status/value pair prevents unavailable metrics becoming zero. */
export type FieldViewMetricResult =
  | (FieldViewMetricResultBase & { status: "available"; value: number })
  | (FieldViewMetricResultBase & {
      status: "insufficient-data" | "unavailable";
      value: null;
    });

/** Machine-readable evidence supporting a FieldView-generated finding. */
export interface FieldViewAnalyticsEvidence {
  evidence_key: string;
  label: string;
  value: number | null;
  unit: string;
  threshold?: number | null;
  sample_size?: number;
  population?: FieldViewAnalyticsPopulation;
}

/**
 * A review prompt backed by explicit evidence. Findings describe observations
 * at their stated scope; they do not establish robot-level causation.
 */
export interface FieldViewAnalyticsFinding {
  finding_key: string;
  category: string;
  scope: "match" | "alliance" | "team" | "event";
  subject_key?: string;
  severity: "high" | "medium" | "low";
  title: string;
  summary: string;
  evidence: FieldViewAnalyticsEvidence[];
  suggested_action: string;
  limitations: string[];
}

/** Event-wide analytics; calculations and findings are produced server-side. */
export interface FieldViewEventAnalytics {
  event_key: EventKey;
  metrics: FieldViewMetricResult[];
  findings: FieldViewAnalyticsFinding[];
}

/** Team-specific and historical analytics for one canonical team identity. */
export interface FieldViewTeamAnalytics {
  team_key: TeamKey;
  metrics: FieldViewMetricResult[];
  findings: FieldViewAnalyticsFinding[];
}
