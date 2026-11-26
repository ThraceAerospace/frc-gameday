import type { FieldViewEventState } from "../../../../packages/domain/src/event.ts";
import type { FieldViewEventTeamSeasonComparisonInput } from "../../../../packages/domain/src/analytics.ts";
import type { FieldViewTeamState, FieldViewTeamEventState } from "../../../../packages/domain/src/team.ts";

/**
 * Versioned transport contracts for the durable event-analytics orchestrator.
 *
 * The Workflow coordinates these messages; it does not own calculations or
 * canonical persistence. EventRuntime and TeamRuntime remain the authorities
 * for their respective records.
 */
export const EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION = 1 as const;

export interface EventAnalyticsTeamInput {
  contract_version: typeof EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION;
  event_key: string;
  event_source_revision: number;
  comparison_input_updated_at: number | null;
  event_state: FieldViewEventState;
}

export interface TeamAnalyticsSeasonInput {
  contract_version: typeof EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION;
  team_key: string;
  team_source_revision: number;
  team_state: FieldViewTeamState;
}

export interface TeamEventAnalyticsCommand {
  contract_version: typeof EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION;
  event_key: string;
  event_source_revision: number;
  event_state: FieldViewEventState;
  comparison_input: FieldViewEventTeamSeasonComparisonInput;
}

export interface TeamEventAnalyticsResult {
  contract_version: typeof EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION;
  event_key: string;
  team_key: string;
  event_source_revision: number;
  team_source_revision: number;
  comparison_input_updated_at: number;
  team_event_revision: number;
  state: FieldViewTeamEventState;
}

/** Exact result identity acknowledged after EventRuntime commits its aggregate. */
export type TeamEventAnalyticsAcknowledgement = Omit<TeamEventAnalyticsResult, "state">;

export interface EventAnalyticsPublicationCommand {
  contract_version: typeof EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION;
  event_key: string;
  event_source_revision: number;
  /** Teams recalculated against this event source revision; other results are retained owner publications. */
  recalculated_team_keys: string[];
  team_results: TeamEventAnalyticsResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isEventAnalyticsTeamInput(value: unknown): value is EventAnalyticsTeamInput {
  return isRecord(value) &&
    value.contract_version === EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION &&
    typeof value.event_key === "string" && /^[0-9]{4}[a-zA-Z0-9_-]+$/.test(value.event_key) &&
    isRevision(value.event_source_revision) &&
    (value.comparison_input_updated_at === null || isRevision(value.comparison_input_updated_at)) &&
    isRecord(value.event_state) && value.event_state.event_key === value.event_key;
}

export function isTeamAnalyticsSeasonInput(value: unknown): value is TeamAnalyticsSeasonInput {
  return isRecord(value) &&
    value.contract_version === EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION &&
    typeof value.team_key === "string" && /^frc[0-9]+$/.test(value.team_key) &&
    isRevision(value.team_source_revision) &&
    isRecord(value.team_state) && value.team_state.team_key === value.team_key;
}

export function isTeamEventAnalyticsCommand(value: unknown): value is TeamEventAnalyticsCommand {
  if (!isRecord(value) || value.contract_version !== EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION ||
      typeof value.event_key !== "string" || !/^[0-9]{4}[a-zA-Z0-9_-]+$/.test(value.event_key) ||
      !isRevision(value.event_source_revision) || !isRecord(value.event_state) ||
      value.event_state.event_key !== value.event_key || !isRecord(value.comparison_input) ||
      !Array.isArray(value.comparison_input.records)) return false;
  return isRevision(value.comparison_input.updated_at);
}

export function isTeamEventAnalyticsResult(value: unknown): value is TeamEventAnalyticsResult {
  return isRecord(value) &&
    value.contract_version === EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION &&
    typeof value.event_key === "string" && /^[0-9]{4}[a-zA-Z0-9_-]+$/.test(value.event_key) &&
    typeof value.team_key === "string" && /^frc[0-9]+$/.test(value.team_key) &&
    isRevision(value.event_source_revision) && isRevision(value.team_source_revision) &&
    isRevision(value.comparison_input_updated_at) && isRevision(value.team_event_revision) &&
    isRecord(value.state) && value.state.event_key === value.event_key &&
    value.state.team_key === value.team_key;
}


export function isTeamEventAnalyticsAcknowledgement(value: unknown): value is TeamEventAnalyticsAcknowledgement {
  if (!isRecord(value) ||
      value.contract_version !== EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION ||
      typeof value.event_key !== "string" || !/^[0-9]{4}[a-zA-Z0-9_-]+$/.test(value.event_key) ||
      typeof value.team_key !== "string" || !/^frc[0-9]+$/.test(value.team_key) ||
      !isRevision(value.event_source_revision) || !isRevision(value.team_source_revision) ||
      !isRevision(value.comparison_input_updated_at) || !isRevision(value.team_event_revision)) return false;
  return true;
}

export function isEventAnalyticsPublicationCommand(value: unknown): value is EventAnalyticsPublicationCommand {
  if (!isRecord(value) ||
      value.contract_version !== EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION ||
      typeof value.event_key !== "string" ||
      !/^[0-9]{4}[a-zA-Z0-9_-]+$/.test(value.event_key) ||
      !isRevision(value.event_source_revision) ||
      !Array.isArray(value.recalculated_team_keys) ||
      !Array.isArray(value.team_results)) return false;

  const recalculated = new Set<string>();
  for (const teamKey of value.recalculated_team_keys) {
    if (typeof teamKey !== "string" || !/^frc[0-9]+$/.test(teamKey) || recalculated.has(teamKey)) return false;
    recalculated.add(teamKey);
  }
  const seenTeams = new Set<string>();
  let comparisonInputUpdatedAt: number | undefined;
  for (const result of value.team_results) {
    if (!isTeamEventAnalyticsResult(result) ||
        result.event_key !== value.event_key ||
        result.event_source_revision > value.event_source_revision ||
        (recalculated.has(result.team_key) && result.event_source_revision !== value.event_source_revision) ||
        seenTeams.has(result.team_key) ||
        (comparisonInputUpdatedAt !== undefined &&
          result.comparison_input_updated_at !== comparisonInputUpdatedAt)) return false;
    comparisonInputUpdatedAt = result.comparison_input_updated_at;
    seenTeams.add(result.team_key);
  }
  return [...recalculated].every((teamKey) => seenTeams.has(teamKey));
}
