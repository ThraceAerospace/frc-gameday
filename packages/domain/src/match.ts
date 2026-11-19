import type {
  TBAMatch,
  TBAEventMatchPrediction,
  TBAEventOPRs,
  TBATeam,
} from "@fieldview/provider-tba/types";
import type {
  StatboticsMatch,
  StatboticsMatchEPA,
  StatboticsMatchResult,
  StatboticsPrediction,
} from "@fieldview/provider-statbotics/types";
import type { FieldViewPlayoffAlliance } from "./playoff-alliance.js";
import type { FieldViewSourceMetadata } from "./source-metadata.js";
import type { TeamKey } from "./ids.js";
import type { FieldViewAnalyticsAudit } from "./analytics.js";

/** Per-team values associated with one alliance in one match. */
export interface FieldViewMatchTeam {
  /** Original TBA identifier, e.g. "frc7407". */
  team_key: TeamKey;
  /** Official TBA team number used to associate Statbotics EPA records. */
  team_number?: TBATeam["team_number"];

  /** Values associated from the TBA event-level OPR resource. */
  opr?: NonNullable<TBAEventOPRs["oprs"]>[string];
  dpr?: NonNullable<TBAEventOPRs["dprs"]>[string];
  ccwm?: NonNullable<TBAEventOPRs["ccwms"]>[string];

  /** Original Statbotics EPA records for the two measurement points. */
  pre_epa?: StatboticsMatchEPA;
  epa?: StatboticsMatchEPA;
}

/**
 * FieldView analysis of one alliance's score.
 * Actual and predicted values retain the source field types; delta is derived.
 */
export interface FieldViewAllianceScoreAnalysis {
  actual: TBAMatch["alliances"]["red"]["score"];
  predicted?: StatboticsPrediction["red_score"];
  /** actual - predicted; only present when both inputs are numeric. */
  delta?: number;
}

export interface FieldViewAllianceEPAAnalysis {
  /** Sum of the three associated teams' pre-match EPA values. */
  pre_match_total: number | null;
  /** Sum of the three associated teams' post-match EPA values. */
  post_match_total: number | null;
  /** Number of teams in the match alliance roster. */
  team_count: number;
  /** Number of valid pre-match EPA values present, even if the total is incomplete. */
  pre_match_team_count: number;
  /** Number of valid post-match EPA values present, even if the total is incomplete. */
  post_match_team_count: number;
  /** Expected alliance roster size for this game. */
  expected_team_count: 3;
}

export interface FieldViewMatchAnalysis {
  score: {
    red: FieldViewAllianceScoreAnalysis;
    blue: FieldViewAllianceScoreAnalysis;
  };
  alliance_epa: {
    red: FieldViewAllianceEPAAnalysis;
    blue: FieldViewAllianceEPAAnalysis;
  };
  /** Reproducible input/definition provenance for the calculated analysis. */
  audit?: FieldViewAnalyticsAudit;
}

export type FieldViewPredictionLabel =
  | "Strong Red"
  | "Lean Red"
  | "Toss-up"
  | "Lean Blue"
  | "Strong Blue";

export type FieldViewAllianceFlag =
  | {
      type: "predicted-win";
      evidence: {
        prediction_source: "statbotics";
        predicted_winner: "red" | "blue";
        red_win_probability: number;
      };
    }
  | {
      type: "predicted-loss";
      evidence: {
        prediction_source: "statbotics";
        predicted_winner: "red" | "blue";
        red_win_probability: number;
      };
    }
  | {
      type: "high-alliance-epa";
      evidence: {
        pre_match_alliance_epa: number;
        event_threshold: number;
        sample_size: number;
      };
    }
  | {
      type: "large-score-delta";
      evidence: {
        actual_score: number;
        predicted_score: number;
        delta: number;
        absolute_delta: number;
        event_threshold: number;
        sample_size: number;
      };
    }
  | {
      type: "anomalous-score";
      evidence: {
        actual_score: number;
        predicted_score: number;
        residual: number;
        phase_median: number;
        phase_margin: number;
        sample_size: number;
      };
    }
  | {
      type: "high-penalties";
      evidence: {
        penalty_points: number;
        event_threshold: number;
        sample_size: number;
      };
    };

export type FieldViewMatchReviewFlag =
  | "model-upset"
  | "anomalous-score"
  | "large-residual"
  | "high-penalties"
  | "high-alliance-epa";

export interface FieldViewMatchFlags {
  prediction: {
    label: FieldViewPredictionLabel;
    prediction_source: "statbotics";
    predicted_winner: "red" | "blue" | null;
    red_win_probability: number;
  } | null;
  /** Winner from TBA, falling back to completed alliance scores. */
  winner: "red" | "blue" | null;
  /** Event- and phase-level match review classifications. */
  review_flags: FieldViewMatchReviewFlag[];
  /** Alliance-specific classifications and their numerical evidence. */
  alliances: {
    red: FieldViewAllianceFlag[];
    blue: FieldViewAllianceFlag[];
  };
}

/**
 * Canonical match object. Every original TBA match field is retained through
 * the TBAMatch extension with exact upstream types. Additional fields are
 * FieldView associations or explicitly sourced Statbotics values.
 */
export interface FieldViewMatch extends TBAMatch {
  /** Distinct Statbotics match context not already represented by TBA. */
  statbotics_week?: StatboticsMatch["week"];
  statbotics_elim?: StatboticsMatch["elim"];
  statbotics_match_name?: StatboticsMatch["match_name"];
  statbotics_status?: StatboticsMatch["status"];
  statbotics_alliances?: StatboticsMatch["alliances"];
  statbotics_result?: StatboticsMatchResult;

  /** Independent predictions; neither source overwrites the other. */
  predictions: {
    tba?: TBAEventMatchPrediction;
    statbotics?: StatboticsPrediction;
  };

  /** Team associations in the same order as the original TBA alliance rosters. */
  teams: {
    red: FieldViewMatchTeam[];
    blue: FieldViewMatchTeam[];
  };

  /** FieldView-calculated values; absent until the calculation is available. */
  analysis?: FieldViewMatchAnalysis;

  /**
   * Absent means not yet resolved. Null means known not to be a playoff match.
   * A present object may contain null for an alliance whose association is
   * known to be unavailable.
   */
  playoff_alliances?: {
    red: FieldViewPlayoffAlliance | null;
    blue: FieldViewPlayoffAlliance | null;
  } | null;

  /** Derived interpretations with explicit evidence. */
  flags?: FieldViewMatchFlags;

  /** Internal per-resource provenance/freshness; not a client DTO. */
  sources: FieldViewSourceMetadata;
}
