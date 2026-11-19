/**
 * Compatibility facade while analytics orchestration migrates to EventRuntime.
 * Calculation implementations live in the backend-owned @fieldview/analytics package.
 */
export { mean, standardDeviation, buildAllianceResults, buildTeamRows, buildReviewFindings, buildTeamInsights, buildSeasonAwareTeamInsights, buildQualificationAnomalies, buildQualificationAnalysis, buildPlayoffAnalysis } from "@fieldview/analytics/calculations";
