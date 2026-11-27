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
  /** 0–100 percentile; null when the comparison population is too small to support one. */
  percentile: number | null;
}

/**
 * Immutable description of one calculation input at the time a run executes.
 * The source revision and digest make the exact upstream representations
 * traceable without copying provider credentials or transport internals.
 */
export interface FieldViewAnalyticsInputRecord {
  input_key: string;
  provider: string;
  resource: string;
  source_revision: number | string | null;
  fetched_at: number | null;
  record_count: number;
  included_count: number;
  excluded_count: number;
  status: "available" | "partial" | "unavailable";
}

/**
 * Run-level audit metadata shared by metrics/findings produced together.
 * input_digest is a deterministic digest of the normalized input manifest.
 */
export interface FieldViewAnalyticsAudit {
  calculation_id: string;
  engine_version: string;
  calculated_at: number;
  input_digest: string;
  inputs: FieldViewAnalyticsInputRecord[];
  definition_versions: Array<{ definition_key: string; version: string }>;
  warnings: string[];
}

/**
 * Public, reviewable specification for a registered calculation.
 *
 * operation_key selects an implementation from the backend's allowlisted
 * operation registry. It is not executable source and must never be eval'd.
 * formula and steps are the human-readable mathematical explanation shown
 * in documentation/audit tooling.
 */
export interface FieldViewAnalyticsDefinition {
  definition_key: string;
  version: string;
  name: string;
  description: string;
  scope: "match" | "alliance" | "team" | "event";
  operation_key: string;
  inputs: Array<{
    input_key: string;
    source_path: string;
    required: boolean;
    description: string;
    unit: string;
  }>;
  population: {
    population_key: string;
    inclusion_rules: string[];
    exclusion_rules: string[];
  };
  formula: {
    expression: string;
    steps: string[];
  };
  output_unit: string;
  interpretation_rules: string[];
  limitations: string[];
}

/** A calculated metric with separate observation and peer-comparison coverage. */
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

/** One team's season movement as ranked within this event's comparison population. */
export interface FieldViewEventTeamComparisonEntry {
  team_key: TeamKey;
  team_number: number;
  prior_event: FieldViewTeamSeasonComparison["prior_event"];
  prior_epa: number;
  current_epa: number;
  change: number;
  rank: number;
  population_size: number;
  components: FieldViewTeamSeasonComparison["components"];
}

/** Event-owned aggregation of TeamRuntime-produced season comparisons. */
export interface FieldViewEventTeamComparisonAnalytics {
  /** Version of the shared comparison input used for this aggregation. */
  input_updated_at: number | null;
  population: {
    expected_team_count: number;
    eligible_team_count: number;
    excluded_team_count: number;
  };
  rankings: FieldViewEventTeamComparisonEntry[];
  largest_change: FieldViewEventTeamComparisonEntry | null;
  smallest_change: FieldViewEventTeamComparisonEntry | null;
  mean_change: number | null;
  team_state_revisions: Array<{ team_key: TeamKey; revision: number | null }>;
  team_event_state_revisions: Array<{ team_key: TeamKey; revision: number | null }>;
}

/** Event-wide analytics; calculations and findings are produced server-side. */
export interface FieldViewEventAnalytics {
  event_key: EventKey;
  metrics: FieldViewMetricResult[];
  findings: FieldViewAnalyticsFinding[];
  /** Alliance-side source observations used by event score and prediction panels. */
  alliance_results?: FieldViewAnalyticsAllianceResult[];
  /** Event-wide team comparison rows, including OPR/DPR/CCWM and EPA coverage. */
  team_summaries?: FieldViewAnalyticsTeamSummary[];
  /** Rankings and EPA movement aggregated from TeamRuntime-owned comparisons. */
  team_comparison?: FieldViewEventTeamComparisonAnalytics;
  /** Full qualification diagnostics and alliance-side anomaly review. */
  qualification?: FieldViewQualificationAnalytics;
  qualification_anomalies?: FieldViewQualificationAnomaly[];
  /** Official-alliance elimination performance. */
  playoffs?: FieldViewPlayoffAnalytics;
  /** Event-wide score residual distribution shown by the original overview. */
  residual_summary?: {
    mean: number | null;
    standard_deviation: number | null;
    sample_size: number;
  };
  /** Summary counts accompanying qualification score-prediction metrics. */
  prediction_summary?: FieldViewQualificationScorePrediction;
  /** Progressive acquisition state for the event's analytics inputs. */
  collection?: {
    state: "queued" | "collecting" | "complete" | "partial";
    processed_match_count: number;
    total_match_count: number;
    unavailable_match_count: number;
    statbotics_fetch_error?: string | null;
    updated_at: number;
  };
  audit?: FieldViewAnalyticsAudit;
}


/** Team analytics scoped to one team's participation at one event. */
export interface FieldViewTeamEventAnalytics {
  team_key: TeamKey;
  event_key: EventKey;
  metrics: FieldViewMetricResult[];
  findings: FieldViewAnalyticsFinding[];
  /** Compact narrative summaries generated by the backend. */
  summary?: string[];
  /** Rank, record, completed-match count, and EPA movement at this event. */
  performance?: {
    rank: number | null;
    wins: number | null;
    losses: number | null;
    ties: number | null;
    matches_seen: number;
    completed_matches: number;
    epa: number | null;
    epa_percentile: number | null;
    auto_epa: number | null;
    teleop_epa: number | null;
    endgame_epa: number | null;
    epa_start: number | null;
    epa_end: number | null;
    epa_change: number | null;
  };
  /** Per-match EPA history for a trend chart; null values remain explicit. */
  epa_trend?: FieldViewTeamEPATrendPoint[];
  /** Comparison against this team's immediately preceding eligible event. */
  season_comparison?: FieldViewTeamSeasonComparison | null;
  /** Target-team residuals compared with other teams' alliance residuals. */
  peer_performance?: FieldViewTeamPeerPerformance;
  /** Event-by-event season history, including unavailable records. */
  season_history?: FieldViewTeamSeasonHistoryEntry[];
  /** Match-level review prompts and supporting values. */
  review_matches?: FieldViewTeamEventAnalyticsMatch[];
  /** Complete canonical match evidence for season-level diagnostics. Includes unflagged matches. */
  match_evidence?: FieldViewTeamMatchEvidence[];
  audit?: FieldViewAnalyticsAudit;
}


/** Complete team-side and opponent-side evidence for one completed match. */
export interface FieldViewTeamMatchEvidence {
  match_key: string;
  match_label: string;
  competition_level: string;
  alliance: "red" | "blue";
  partner_team_numbers: number[];
  opponent_team_numbers: number[];
  predicted_score: number | null;
  actual_score: number | null;
  score_residual: number | null;
  opponent_predicted_score: number | null;
  opponent_actual_score: number | null;
  opponent_score_residual: number | null;
  win_probability: number | null;
  won: boolean | null;
  pre_match_epa: number | null;
  post_match_epa: number | null;
  epa_change: number | null;
  alliance_pre_epa_total: number | null;
  opponent_pre_epa_total: number | null;
  alliance_pre_components: Record<string, number>;
  actual_components: Record<string, number>;
  pre_match_components: Record<string, number>;
  post_match_components: Record<string, number>;
  alliance_delta_spread: number | null;
  shared_alliance_update: boolean;
}

/** One alliance-side observation used by event-wide score analysis. */
export interface FieldViewAnalyticsAllianceResult {
  match_key: string;
  match_label: string;
  competition_level: string;
  alliance: "red" | "blue";
  team_keys: TeamKey[];
  predicted_score: number | null;
  actual_score: number | null;
  score_residual: number | null;
  pre_match_epa_total: number | null;
  winner: boolean;
  outcome: "win" | "loss" | "tie" | "unknown";
}

/** Event-level team row used by the original Insights comparison table. */
export interface FieldViewAnalyticsTeamSummary {
  team_key: TeamKey;
  team_number: number;
  name: string;
  opr: number | null;
  dpr: number | null;
  ccwm: number | null;
  epa: number | null;
  auto_epa: number | null;
  teleop_epa: number | null;
  endgame_epa: number | null;
  matches_seen: number;
  epa_percentile: number | null;
  epa_contribution_percent: number | null;
  epa_contribution_samples: number;
}

/** Qualification score-prediction diagnostics, retaining the legacy measures. */
export interface FieldViewQualificationScorePrediction {
  alliance_count: number;
  mean_absolute_error: number | null;
  root_mean_square_error: number | null;
  mean_residual: number | null;
  within_25_count: number;
  win_prediction_count: number;
  win_prediction_accuracy: number | null;
}

export interface FieldViewQualificationPredictionBin {
  label: string;
  count: number;
  mean_predicted: number;
  observed_red_win_rate: number;
  calibration_error: number;
}

export interface FieldViewQualificationHighConfidenceMiss {
  match_key: string;
  match_label: string;
  predicted_winner: "red" | "blue";
  probability: number;
}

export interface FieldViewQualificationPenaltyMatch {
  match_key: string;
  match_label: string;
  match_number: number;
  red_penalty_count: number | null;
  blue_penalty_count: number | null;
  red_penalty_points: number;
  blue_penalty_points: number;
  total_penalty_points: number;
  red_flagged: boolean;
  blue_flagged: boolean;
}

/** Complete qualification diagnostics previously returned by the Insights API. */
export interface FieldViewQualificationAnalytics {
  prediction_calibration: {
    match_count: number;
    correct_count: number;
    underdog_wins: number;
    accuracy: number | null;
    brier_score: number | null;
    high_confidence_misses: FieldViewQualificationHighConfidenceMiss[];
    bins: FieldViewQualificationPredictionBin[];
  };
  score_prediction: FieldViewQualificationScorePrediction;
  progression: Array<{
    label: string;
    first_match: number;
    last_match: number;
    alliance_count: number;
    mean_absolute_error: number | null;
    mean_residual: number | null;
  }>;
  penalties: {
    sample_size: number;
    matches_with_penalty_points: number;
    total_penalty_points: number;
    mean_penalty_points: number | null;
    median_penalty_points: number | null;
    outlier_threshold: number | null;
    flagged_matches: FieldViewQualificationPenaltyMatch[];
  };
}

/** A qualification alliance-side result flagged for deeper review. */
export interface FieldViewQualificationAnomaly {
  anomaly_key: string;
  match_key: string;
  match_label: string;
  alliance: "red" | "blue";
  team_keys: TeamKey[];
  predicted_score: number;
  actual_score: number;
  score_residual: number;
  margin_of_error: number | null;
  standardized_residual: number | null;
  win_probability: number | null;
  outside_expected_range: boolean;
  high_confidence_miss: boolean;
  severity: "high" | "medium";
  reasons: string[];
}

/** One playoff match from the perspective of an official alliance. */
export interface FieldViewPlayoffAllianceMatch {
  match_key: string;
  competition_level: string;
  alliance: "red" | "blue";
  outcome: "win" | "loss" | "tie" | "unknown";
  score_residual: number | null;
  actual_score: number | null;
  predicted_score: number | null;
}

/** Aggregated playoff performance for an official TBA alliance. */
export interface FieldViewPlayoffAlliancePerformance {
  /** Official TBA alliance name; null when the source does not provide one. */
  name: string | null;
  team_keys: TeamKey[];
  match_count: number;
  scored_match_count: number;
  wins: number;
  losses: number;
  ties: number;
  unknown_outcomes: number;
  mean_predicted_score: number | null;
  mean_actual_score: number | null;
  mean_score_residual: number | null;
  residual_standard_deviation: number | null;
  matches: FieldViewPlayoffAllianceMatch[];
}

export interface FieldViewPlayoffAnalytics {
  match_count: number;
  alliance_count: number;
  alliances: FieldViewPlayoffAlliancePerformance[];
}

/** Per-match team context retained by the original team-insights panel. */
export interface FieldViewTeamEventAnalyticsMatch {
  match_key: string;
  match_label: string;
  alliance: "red" | "blue";
  partner_team_numbers: number[];
  opponent_team_numbers: number[];
  predicted_score: number | null;
  actual_score: number | null;
  score_residual: number | null;
  win_probability: number | null;
  won: boolean | null;
  pre_match_epa: number | null;
  post_match_epa: number | null;
  epa_change: number | null;
  reasons: string[];
}

export interface FieldViewTeamEPATrendPoint {
  match_key: string;
  match_label: string;
  epa: number | null;
}

export interface FieldViewTeamSeasonHistoryEntry {
  event: {
    event_key: EventKey;
    event_name: string;
    start_date: string;
  };
  epa_total: number | null;
  match_count: number | null;
  status: "ready" | "unavailable";
}

export interface FieldViewTeamSeasonComponentComparison {
  prior: number;
  current: number;
  change: number;
  comparison_rank: number;
  comparison_size: number;
}

/** Same-team, prior-event comparison and its event comparison population. */
export interface FieldViewTeamSeasonComparison {
  prior_event: {
    event_key: EventKey;
    event_name: string;
    short_name: string | null;
    start_date: string;
  };
  prior_epa: number;
  current_epa: number;
  current_epa_percentile: number | null;
  prior_epa_rank: number;
  prior_epa_comparison_size: number;
  current_epa_rank: number;
  current_epa_comparison_size: number;
  change: number;
  comparison_rank: number;
  comparison_size: number;
  components: {
    auto: FieldViewTeamSeasonComponentComparison | null;
    teleop: FieldViewTeamSeasonComponentComparison | null;
    endgame: FieldViewTeamSeasonComponentComparison | null;
  };
}

export interface FieldViewTeamPeerPerformance {
  team_match_count: number;
  peer_alliance_count: number;
  team_mean_residual: number | null;
  peer_mean_residual: number | null;
  difference: number | null;
  interpretation:
    | "above-peers"
    | "below-peers"
    | "similar-to-peers"
    | "insufficient-sample";
}

/** One team's historical event result used as an input to event-team comparisons. */
export interface FieldViewEventTeamSeasonRecord {
  team_number: number;
  event: {
    event_key: EventKey;
    event_name: string;
    short_name: string | null;
    start_date: string;
  };
  epa_total: number | null;
  epa_unitless: number | null;
  breakdown: Record<string, number>;
  wins: number | null;
  losses: number | null;
  ties: number | null;
  match_count: number | null;
  fetched_at: number;
  status: "ready" | "unavailable";
}

/** EventRuntime-built season comparison input shared with participating TeamRuntimes. */
export interface FieldViewEventTeamSeasonComparisonInput {
  state: "queued" | "discovering" | "collecting" | "complete" | "partial";
  team_count: number;
  total_team_event_records: number;
  processed_team_event_records: number;
  unavailable_team_event_records: number;
  discovery_pending_teams: number;
  /** Teams whose season event-history resource was attempted but unavailable. */
  history_unavailable_teams?: number;
  updated_at: number;
  /** Revisions of the TeamRuntime season states used to build this input. */
  team_state_revisions: Array<{ team_key: TeamKey; revision: number | null }>;
  records: FieldViewEventTeamSeasonRecord[];
}
