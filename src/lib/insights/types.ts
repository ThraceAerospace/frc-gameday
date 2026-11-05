import type { StatboticsMatch } from "@/lib/statbotics/types";
import type { TBAEvent, TBAMatch } from "@/lib/tba/types";

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
  oprPercentile: number | null;
  allianceResidualMean: number | null;
  allianceResidualSpread: number | null;
};

export type ReviewFinding = {
  id: string;
  category: "score-residual" | "model-disagreement" | "rating-update" | "alliance-pattern";
  subject: string;
  title: string;
  description: string;
  evidence: string[];
  sampleSize: number;
  sampleCoverage: "low" | "medium" | "high";
  suggestedAction: string;
  severity: "high" | "medium" | "low";
};

export type EventAnalyticsResponse = {
  event: TBAEvent;
  teams: TeamAnalyticsRow[];
  matches: AnalyticsMatch[];
  allianceResults: AllianceResult[];
  findings: ReviewFinding[];
  matchCount: number;
  loadedMatchCount: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  residualStats: { mean: number | null; standardDeviation: number | null; sampleSize: number };
};
