import {
  buildAllianceResults,
  buildPlayoffAnalysis,
  buildQualificationAnalysis,
  buildQualificationAnomalies,
  buildReviewFindings,
  buildSeasonAwareTeamInsights,
  buildTeamRows,
  buildTeamInsights,
} from "./calculations.ts";
import { buildMatchFlagContext, buildMatchFlags, type MatchFlagContext } from "./match-flags.ts";
import type {
  AllianceResult,
  AnalyticsMatch,
  TeamAnalyticsRow,
  EventAnalyticsResponse,
  FieldViewEventTeamSeasonComparisonSnapshot,
} from "./types.ts";
import type { TBAEliminationAlliance, TBAMatch } from "@fieldview/provider-tba/types";
import { AnalyticsEngine, AnalyticsOperationRegistry, type AnalyticsOperation } from "./engine.ts";
import { FIELDVIEW_ANALYTICS_DEFINITIONS } from "./definitions.ts";

type TeamInput = Parameters<typeof buildTeamRows>[0];
type OprInput = Parameters<typeof buildTeamRows>[1];
type RankingInput = Parameters<typeof buildTeamInsights>[3];

export interface FieldViewAnalyticsOperationContext {
  records: AnalyticsMatch[];
  allEventMatches?: TBAMatch[];
  teams?: TeamInput;
  teamRows?: TeamAnalyticsRow[];
  oprs?: OprInput;
  rankings?: RankingInput;
  comparisonInput?: FieldViewEventTeamSeasonComparisonSnapshot;
  targetEventKey?: string;
  targetStartDate?: string;
  playoffType?: number | null;
  allianceResults?: AllianceResult[];
  officialAlliances?: TBAEliminationAlliance[] | null;
  matchFlagData?: Pick<EventAnalyticsResponse, "allianceResults" | "qualificationAnalysis">;
  matchRecord?: AnalyticsMatch;
  matchFlagContext?: MatchFlagContext;
}

function required<T>(value: T | null | undefined, name: string): T {
  if (value === undefined || value === null) throw new Error("Analytics operation requires context." + name);
  return value;
}

/** Default allowlist for every operation referenced by the versioned catalog. */
export function createFieldViewAnalyticsOperationRegistry(): AnalyticsOperationRegistry {
  return new AnalyticsOperationRegistry([
    { operation_key: "buildAllianceResults", execute: (context: FieldViewAnalyticsOperationContext) =>
      buildAllianceResults(required(context.records, "records"), context.playoffType) },
    { operation_key: "buildTeamRows", execute: (context: FieldViewAnalyticsOperationContext) =>
      buildTeamRows(required(context.teams, "teams"), context.oprs ?? null, required(context.records, "records")) },
    { operation_key: "buildReviewFindings", execute: (context: FieldViewAnalyticsOperationContext) =>
      buildReviewFindings(required(context.records, "records"), required(context.allianceResults, "allianceResults")) },
    { operation_key: "buildQualificationAnomalies", execute: (context: FieldViewAnalyticsOperationContext) =>
      buildQualificationAnomalies(required(context.records, "records"), required(context.allianceResults, "allianceResults"), context.playoffType) },
    { operation_key: "buildQualificationAnalysis", execute: (context: FieldViewAnalyticsOperationContext) =>
      buildQualificationAnalysis(required(context.records, "records"), required(context.allEventMatches, "allEventMatches"), required(context.allianceResults, "allianceResults"), context.playoffType) },
    { operation_key: "buildPlayoffAnalysis", execute: (context: FieldViewAnalyticsOperationContext) =>
      buildPlayoffAnalysis(required(context.allianceResults, "allianceResults"), context.officialAlliances ?? null) },
    { operation_key: "buildSeasonAwareTeamInsights", execute: (context: FieldViewAnalyticsOperationContext) =>
      buildSeasonAwareTeamInsights(
        required(context.records, "records"),
        required(context.allianceResults, "allianceResults"),
        required(context.teamRows, "teamRows"),
        context.rankings ?? null,
        required(context.comparisonInput, "comparisonInput"),
        required(context.targetEventKey, "targetEventKey"),
        required(context.targetStartDate, "targetStartDate"),
        context.playoffType,
      ) },
    { operation_key: "buildMatchFlags", execute: (context: FieldViewAnalyticsOperationContext) => {
      const data = required(context.matchFlagData, "matchFlagData");
      const record = required(context.matchRecord, "matchRecord");
      return buildMatchFlags(
        { allianceResults: data.allianceResults, qualificationAnalysis: data.qualificationAnalysis },
        record,
        context.matchFlagContext ?? buildMatchFlagContext(data),
      );
    } },
  ]);
}

/** Ready-to-use engine bound to the reviewed, versioned catalog and explicit operation allowlist. */
export function createFieldViewAnalyticsEngine(): AnalyticsEngine {
  return new AnalyticsEngine(FIELDVIEW_ANALYTICS_DEFINITIONS, createFieldViewAnalyticsOperationRegistry());
}
