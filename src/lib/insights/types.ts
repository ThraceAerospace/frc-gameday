import type { StatboticsMatch } from "@/lib/statbotics/types";
import type { TBAEliminationAlliance, TBAEvent, TBAEventRanking, TBAMatch } from "@/lib/tba/types";

export type AnalyticsMatch = {
  match: TBAMatch;
  statbotics: StatboticsMatch | null;
  statboticsStatus: "ready" | "unavailable";
};

export type AllianceResult = {
  matchKey: string;
  matchLabel: string;
  compLevel: string;
  color: "red" | "blue";
  teamKeys: string[];
  predicted: number | null;
  actual: number | null;
  residual: number | null;
  preEpaTotal: number | null;
  winner: boolean;
  outcome: "win" | "loss" | "tie" | "unknown";
};

export type TeamAnalyticsRow = {
  teamKey: string;
  teamNumber: number;
  name: string;
  opr: number | null;
  dpr: number | null;
  ccwm: number | null;
  epa: number | null;
  autoEpa: number | null;
  teleopEpa: number | null;
  endgameEpa: number | null;
  matchesSeen: number;
  epaPercentile: number | null;
  epaContributionPercent: number | null;
  epaContributionSamples: number;
};

export type ReviewFinding = {
  id: string;
  category: "score-residual" | "alliance-pattern" | "penalty-frequency";
  subject: string;
  title: string;
  description: string;
  evidence: string[];
  sampleSize: number;
  sampleCoverage: "low" | "medium" | "high";
  suggestedAction: string;
  severity: "high" | "medium" | "low";
};

export type QualificationAnomaly = {
  id: string; matchKey: string; matchLabel: string; alliance: "red" | "blue"; teamKeys: string[];
  predicted: number; actual: number; residual: number; marginOfError: number | null;
  standardizedResidual: number | null; winProbability: number | null;
  outsideExpectedRange: boolean; highConfidenceMiss: boolean; severity: "high" | "medium"; reasons: string[];
};
export type QualificationAnalysis = {
  predictionCalibration: {
    matchCount: number;
    correctCount: number;
    underdogWins: number;
    accuracy: number | null;
    brierScore: number | null;
    highConfidenceMisses: { matchKey: string; matchLabel: string; predictedWinner: "red" | "blue"; probability: number }[];
    bins: { label: string; count: number; meanPredicted: number; observedRedWinRate: number; calibrationError: number }[];
  };
  scorePrediction: { allianceCount: number; meanAbsoluteError: number | null; rootMeanSquareError: number | null; meanResidual: number | null };
  progression: { label: string; firstMatch: number; lastMatch: number; allianceCount: number; meanAbsoluteError: number | null; meanResidual: number | null }[];
  penalties: {
    sampleSize: number; matchesWithPenaltyPoints: number; totalPenaltyPoints: number;
    meanPenaltyPoints: number | null; medianPenaltyPoints: number | null; outlierThreshold: number | null;
    flaggedMatches: { matchKey: string; matchLabel: string; matchNumber: number; redPenaltyCount: number | null; bluePenaltyCount: number | null; redPenaltyPoints: number; bluePenaltyPoints: number; totalPenaltyPoints: number; redFlagged: boolean; blueFlagged: boolean }[];
  };
};

export type PlayoffAlliancePerformance = {
  /** Official TBA alliance name; null when TBA does not provide one. */
  name: string | null;
  teamKeys: string[];
  matchCount: number;
  scoredMatchCount: number;
  wins: number;
  losses: number;
  ties: number;
  unknownOutcomes: number;
  meanPredicted: number | null;
  meanActual: number | null;
  meanResidual: number | null;
  residualStandardDeviation: number | null;
  matches: { matchKey: string; compLevel: string; color: "red" | "blue"; outcome: "win" | "loss" | "tie" | "unknown"; residual: number | null; actual: number | null; predicted: number | null }[];
};
export type PlayoffAnalysis = {
  matchCount: number;
  allianceCount: number;
  alliances: PlayoffAlliancePerformance[];
};
export type EventAnalyticsResponse = {
  event: TBAEvent;
  rankings?: TBAEventRanking | null;
  teams: TeamAnalyticsRow[];
  matches: AnalyticsMatch[];
  allianceResults: AllianceResult[];
  findings: ReviewFinding[];
  qualificationAnomalies?: QualificationAnomaly[];
  qualificationAnalysis?: QualificationAnalysis;
  playoffAnalysis?: PlayoffAnalysis;
  teamInsights?: TeamInsight[];
  seasonCohort?: SeasonCohortSnapshot;
  matchCount: number;
  loadedMatchCount: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  residualStats: { mean: number | null; standardDeviation: number | null; sampleSize: number };
  predictionStats: { allianceCount: number; meanAbsoluteError: number | null; rootMeanSquareError: number | null; meanResidual: number | null; within25Count: number; winPredictionCount: number; winPredictionAccuracy: number | null };
  collection: { state: "queued" | "collecting" | "complete" | "partial"; processedMatchCount: number; totalMatchCount: number; unavailableMatchCount: number; statboticsFetchError?: string | null; updatedAt: number };
};


export type TeamInsightMatch = {
  matchKey: string;
  matchLabel: string;
  alliance: "red" | "blue";
  partners: number[];
  opponents: number[];
  predicted: number | null;
  actual: number | null;
  residual: number | null;
  winProbability: number | null;
  won: boolean | null;
  preEPA: number | null;
  postEPA: number | null;
  deltaEPA: number | null;
  reasons: string[];
};

export type TeamInsight = {
  teamNumber: number;
  summary: string[];
  metrics: {
    rank: number | null;
    wins: number | null;
    losses: number | null;
    ties: number | null;
    matchesSeen: number;
    completedMatches: number;
    epa: number | null;
    epaPercentile: number | null;
    autoEpa: number | null;
    teleopEpa: number | null;
    endgameEpa: number | null;
    epaStart: number | null;
    epaEnd: number | null;
    epaChange: number | null;
  };
  epaTrend: { matchKey: string; matchLabel: string; epa: number | null }[];
  seasonComparison: TeamSeasonComparison | null;
  peerPerformance: { teamMatches: number; peerAllianceCount: number; teamMeanResidual: number | null; peerMeanResidual: number | null; difference: number | null; interpretation: "above-peers" | "below-peers" | "similar-to-peers" | "insufficient-sample" };
  seasonHistory: { event: { key: string; name: string; startDate: string }; epaTotal: number | null; matches: number | null; status: "ready" | "unavailable" }[];
  reviewMatches: TeamInsightMatch[];
};


export type SeasonCohortRecord = {
  teamNumber: number;
  event: { key: string; name: string; shortName: string; startDate: string };
  epaTotal: number | null;
  epaUnitless: number | null;
  breakdown: Record<string, number>;
  wins: number | null;
  losses: number | null;
  ties: number | null;
  matches: number | null;
  fetchedAt: number;
  status: "ready" | "unavailable";
};

export type SeasonCohortSnapshot = {
  state: "queued" | "discovering" | "collecting" | "complete" | "partial";
  teamCount: number;
  totalTeamEventRecords: number;
  processedTeamEventRecords: number;
  unavailableTeamEventRecords: number;
  discoveryPendingTeams: number;
  updatedAt: number;
  records: SeasonCohortRecord[];
};

export type TeamSeasonComponentComparison = {
  prior: number;
  current: number;
  change: number;
  cohortRank: number;
  cohortSize: number;
};

export type TeamSeasonComparison = {
  priorEvent: { key: string; name: string; startDate: string };
  priorEPA: number;
  currentEPA: number;
  currentEpaPercentile: number | null;
  priorEpaRank: number;
  priorEpaCohortSize: number;
  currentEpaRank: number;
  currentEpaCohortSize: number;
  change: number;
  cohortRank: number;
  cohortSize: number;
  components: {
    auto: TeamSeasonComponentComparison | null;
    teleop: TeamSeasonComponentComparison | null;
    endgame: TeamSeasonComponentComparison | null;
  };
};
