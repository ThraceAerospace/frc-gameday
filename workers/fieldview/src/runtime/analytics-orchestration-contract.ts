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

export interface EventAnalyticsPublicationCommand {
  contract_version: typeof EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION;
  event_key: string;
  event_source_revision: number;
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
