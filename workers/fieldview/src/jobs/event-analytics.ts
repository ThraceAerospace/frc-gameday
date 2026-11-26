import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { RuntimeEnvironment } from "../runtime/cloudflare.ts";
import {
  EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION,
  isEventAnalyticsTeamInput,
  isTeamAnalyticsSeasonInput,
  isTeamEventAnalyticsResult,
} from "../runtime/analytics-orchestration-contract.ts";
import type {
  EventAnalyticsPublicationCommand,
  TeamEventAnalyticsResult,
} from "../runtime/analytics-orchestration-contract.ts";
import { buildFieldViewEventTeamSeasonComparisonInput } from "../../../../packages/analytics/src/event-team-season-comparison.ts";
import type { FieldViewTeamState } from "../../../../packages/domain/src/team.ts";
import type { FieldViewEventState } from "../../../../packages/domain/src/event.ts";
import { createDiscoveryStoreClient } from "./discovery-store.ts";
import { isRetryableWorkflowHttpStatus } from "./retry-policy.ts";

export interface EventAnalyticsWorkflowParameters {
  event_key: string;
  /** null means the match collection was not safely comparable and the full roster must be recalculated. */
  affected_team_keys: string[] | null;
  requested_at: number;
  attempt?: number;
}

interface ExistingTeamEventState {
  result: TeamEventAnalyticsResult | null;
}

async function mapLimit<T, R>(items: T[], limit: number, callback: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await callback(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function headers(env: RuntimeEnvironment, identityHeader: string, identity: string): Headers {
  if (!env.RUNTIME_ADMIN_TOKEN) throw new Error("Runtime authorization is unavailable");
  return new Headers({
    Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN,
    [identityHeader]: identity,
    "Content-Type": "application/json",
  });
}

function validEventKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{4}[a-zA-Z0-9_-]+$/.test(value);
}

function existingResult(
  eventKey: string,
  teamKey: string,
  state: unknown,
  responseHeaders: Headers,
): TeamEventAnalyticsResult | null {
  const eventRevisionHeader = responseHeaders.get("X-FieldView-Event-Source-Revision");
  const teamRevisionHeader = responseHeaders.get("X-FieldView-Team-Source-Revision");
  const comparisonUpdatedAtHeader = responseHeaders.get("X-FieldView-Comparison-Input-Updated-At");
  const teamEventRevisionHeader = responseHeaders.get("X-FieldView-Team-Event-Revision");
  if (eventRevisionHeader === null || teamRevisionHeader === null ||
      comparisonUpdatedAtHeader === null || teamEventRevisionHeader === null) return null;
  const eventRevision = Number(eventRevisionHeader);
  const teamRevision = Number(teamRevisionHeader);
  const comparisonUpdatedAt = Number(comparisonUpdatedAtHeader);
  const teamEventRevision = Number(teamEventRevisionHeader);
  const result = {
    contract_version: EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION,
    event_key: eventKey,
    team_key: teamKey,
    event_source_revision: eventRevision,
    team_source_revision: teamRevision,
    comparison_input_updated_at: comparisonUpdatedAt,
    team_event_revision: teamEventRevision,
    state,
  };
  return isTeamEventAnalyticsResult(result) ? result : null;
}

/**
 * Coordinates cross-runtime analytics without owning provider I/O or canonical
 * state. TeamRuntime owns every TeamEventState; EventRuntime owns aggregation.
 */
type EventAnalyticsEnvironment = RuntimeEnvironment & { EVENT_ANALYTICS_WORKFLOW?: Workflow };

export class EventAnalyticsWorkflow extends WorkflowEntrypoint<EventAnalyticsEnvironment, EventAnalyticsWorkflowParameters> {
  async run(event: WorkflowEvent<EventAnalyticsWorkflowParameters>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const eventKey = event.payload?.event_key;
    const affected = event.payload?.affected_team_keys;
    const requestedAt = event.payload?.requested_at;
    const attempt = Number.isSafeInteger(event.payload?.attempt) ? Number(event.payload?.attempt) : 0;
    if (!validEventKey(eventKey) ||
        !(affected === null || (Array.isArray(affected) &&
          affected.every((key) => typeof key === "string" && /^frc[0-9]+$/.test(key)))) ||
        (typeof requestedAt !== "number" || !Number.isSafeInteger(requestedAt))) {
      throw new Error("Invalid event analytics Workflow parameters");
    }
    if (!this.env.EVENT_RUNTIME || !this.env.TEAM_RUNTIME || !this.env.DISCOVERY_STORE) {
      throw new Error("Event analytics Workflow runtime bindings are unavailable");
    }
    const year = Number(eventKey.slice(0, 4));
    const eventStub = this.env.EVENT_RUNTIME.get(this.env.EVENT_RUNTIME.idFromName(eventKey));
    const eventHeaders = headers(this.env, "X-FieldView-Event-Key", eventKey);
    const scheduleRetry = async (reason: string, retryAffected: string[] | null = affected): Promise<string | null> => {
      if (attempt >= 2 || !this.env.EVENT_ANALYTICS_WORKFLOW) return null;
      const retryId = "event-analytics-" + eventKey + "-" + requestedAt + "-retry-" + (attempt + 1);
      await step.do("schedule-" + reason + "-retry-" + (attempt + 1), async () => {
        await this.env.EVENT_ANALYTICS_WORKFLOW!.create({
          id: retryId,
          params: {
            event_key: eventKey,
            affected_team_keys: retryAffected,
            requested_at: requestedAt,
            attempt: attempt + 1,
          },
        });
        return retryId;
      });
      return retryId;
    };

    const eventInput = await step.do("read-versioned-event-analytics-input", {
      retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
    }, async () => {
      const response = await eventStub.fetch(new Request("https://event-runtime/analytics-orchestration-input", {
        headers: eventHeaders,
      }));
      if (!response.ok) throw new Error("Event analytics input returned HTTP " + response.status);
      const value: unknown = await response.json();
      if (!isEventAnalyticsTeamInput(value) || value.event_key !== eventKey) {
        throw new Error("Event analytics input failed its versioned contract");
      }
      return value;
    });

    const eventState = eventInput.event_state as FieldViewEventState;
    if (!eventState.event || !Array.isArray(eventState.teams)) {
      throw new Error("Event analytics input is missing its event identity or roster");
    }
    const participants = eventState.teams.flatMap((team) =>
      typeof team.team_number === "number" && /^frc[0-9]+$/.test(team.key)
        ? [{ team_key: team.key, team_number: team.team_number }]
        : [],
    );
    const discovery = createDiscoveryStoreClient(this.env.DISCOVERY_STORE);
    const registered = await step.do("resolve-registered-team-runtime-owners", async () =>
      mapLimit(participants, 8, async (team) => ({
        ...team,
        registered: Boolean(await discovery.get("registry/runtime-teams/" + team.team_key + ".json")),
      })),
    );
    const registeredTeams = registered.filter((team) => team.registered);
    const teamNamespace = this.env.TEAM_RUNTIME;

    const seasonInputs = await step.do("read-versioned-team-season-inputs", {
      retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
    }, async () => mapLimit(registeredTeams, 8, async (team) => {
      try {
        const response = await teamNamespace.get(teamNamespace.idFromName(team.team_key)).fetch(
          new Request("https://team-runtime/analytics-season-input?year=" + year, {
            headers: headers(this.env, "X-FieldView-Team-Key", team.team_key),
          }),
        );
        if (!response.ok) return {
          team_key: team.team_key, input: null, state: null, revision: null, status: response.status,
        };
        const value: unknown = await response.json();
        if (!isTeamAnalyticsSeasonInput(value) || value.team_key !== team.team_key) {
          return { team_key: team.team_key, input: null, state: null, revision: null, status: 502 };
        }
        return {
          team_key: team.team_key,
          input: value,
          state: value.team_state as FieldViewTeamState,
          revision: value.team_source_revision,
          status: 200,
        };
      } catch {
        return { team_key: team.team_key, input: null, state: null, revision: null, status: 503 };
      }
    }));

    const failedSeasonInput = seasonInputs.find((item) => item.status !== 200 && item.status !== 404);
    if (failedSeasonInput) {
      if (isRetryableWorkflowHttpStatus(failedSeasonInput.status)) {
        const retryId = await scheduleRetry("team-season-input-failure", null);
        if (retryId) return {
          event_key: eventKey,
          status: "retry_scheduled",
          retry_workflow_id: retryId,
          reason: "team_season_input_failure",
        };
      }
      throw new Error("TeamRuntime " + failedSeasonInput.team_key +
        " season analytics input returned HTTP " + failedSeasonInput.status);
    }

    const existingStates = await step.do("read-current-team-event-publications", {
      retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
    }, async () => mapLimit(registeredTeams, 8, async (team): Promise<ExistingTeamEventState & { team_key: string }> => {
      try {
        const response = await teamNamespace.get(teamNamespace.idFromName(team.team_key)).fetch(
          new Request("https://team-runtime/event-state?event_key=" + encodeURIComponent(eventKey), {
            headers: headers(this.env, "X-FieldView-Team-Key", team.team_key),
          }),
        );
        if (!response.ok) return { team_key: team.team_key, result: null };
        const state: unknown = await response.json();
        return { team_key: team.team_key, result: existingResult(eventKey, team.team_key, state, response.headers) };
      } catch {
        return { team_key: team.team_key, result: null };
      }
    }));

    const previousUpdatedAt = Number(eventInput.comparison_input_updated_at ?? 0);
    const seasonInputChanged = registered.length !== participants.length ||
      registeredTeams.some((team) => {
        const next = seasonInputs.find((item) => item.team_key === team.team_key);
        const previous = existingStates.find((item) => item.team_key === team.team_key)?.result;
        return !next?.state || !previous || !previous.state.analytics ||
          previous.team_source_revision !== next.revision ||
          previous.comparison_input_updated_at !== previousUpdatedAt;
      });
    const recalculateAll = affected === null || previousUpdatedAt <= 0 || seasonInputChanged;
    const affectedSet = new Set(affected ?? []);
    const teamsToRecalculate = registeredTeams.filter((team) => {
      const hasSeasonInput = Boolean(seasonInputs.find((item) => item.team_key === team.team_key)?.state);
      return hasSeasonInput && (recalculateAll || affectedSet.has(team.team_key));
    });
    const updatedAt = recalculateAll
      ? Math.max(Date.now(), previousUpdatedAt + 1)
      : previousUpdatedAt;
    const snapshots = participants.map((team) =>
      seasonInputs.find((item) => item.team_key === team.team_key)?.state ?? null,
    );
    const teamStateRevisions = participants.map((team) => ({
      team_key: team.team_key,
      revision: seasonInputs.find((item) => item.team_key === team.team_key)?.revision ?? null,
    }));
    const comparisonInput = buildFieldViewEventTeamSeasonComparisonInput(
      eventState.event,
      participants.map((team) => team.team_number),
      snapshots,
      updatedAt,
      teamStateRevisions,
    );

    const recalculationOutcomes = await step.do("recalculate-affected-team-event-analytics", {
      retries: { limit: 3, delay: "15 seconds", backoff: "exponential" },
    }, async () => mapLimit(teamsToRecalculate, 6, async (team) => {
      const response = await teamNamespace.get(teamNamespace.idFromName(team.team_key)).fetch(
        new Request("https://team-runtime/event-analytics?year=" + year, {
          method: "POST",
          headers: headers(this.env, "X-FieldView-Team-Key", team.team_key),
          body: JSON.stringify({
            contract_version: EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION,
            event_key: eventKey,
            event_source_revision: eventInput.event_source_revision,
            event_state: eventState,
            comparison_input: comparisonInput,
          }),
        }),
      );
      if (!response.ok) return { team_key: team.team_key, status: response.status, result: null };
      const result: unknown = await response.json();
      if (!isTeamEventAnalyticsResult(result) || result.team_key !== team.team_key ||
          result.event_key !== eventKey || result.event_source_revision !== eventInput.event_source_revision ||
          result.comparison_input_updated_at !== updatedAt) {
        throw new Error("TeamRuntime " + team.team_key + " returned an invalid analytics result envelope");
      }
      return { team_key: team.team_key, status: response.status, result };
    }));
    if (recalculationOutcomes.some((item) => item.status === 409)) {
      const retryId = await scheduleRetry("team-revision-conflict");
      if (retryId) return {
        event_key: eventKey, status: "retry_scheduled", retry_workflow_id: retryId,
        reason: "team_revision_conflict",
      };
      throw new Error("TeamRuntime analytics input revisions changed during orchestration");
    }
    const failedTeam = recalculationOutcomes.find((item) => item.result === null);
    if (failedTeam) {
      if (isRetryableWorkflowHttpStatus(failedTeam.status)) {
        const retryId = await scheduleRetry("team-analytics-failure");
        if (retryId) return {
          event_key: eventKey, status: "retry_scheduled", retry_workflow_id: retryId,
          reason: "team_analytics_failure",
        };
      }
      throw new Error("TeamRuntime " + failedTeam.team_key + " analytics returned HTTP " + failedTeam.status);
    }
    const recalculated = recalculationOutcomes.map((item) => item.result as TeamEventAnalyticsResult);

    const recalculatedByKey = new Map(recalculated.map((result) => [result.team_key, result]));
    const teamResults: TeamEventAnalyticsResult[] = [];
    for (const team of registeredTeams) {
      const fresh = recalculatedByKey.get(team.team_key);
      const retained = existingStates.find((item) => item.team_key === team.team_key)?.result;
      const result = fresh ?? retained;
      if (result && result.comparison_input_updated_at === updatedAt) teamResults.push(result);
    }
    const recalculatedTeamKeys = recalculated.map((result) => result.team_key);
    const publication: EventAnalyticsPublicationCommand = {
      contract_version: EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION,
      event_key: eventKey,
      event_source_revision: eventInput.event_source_revision,
      recalculated_team_keys: recalculatedTeamKeys,
      team_results: teamResults,
    };

    const publicationResult = await step.do("publish-event-analytics-aggregate", {
      retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
    }, async () => {
      const response = await eventStub.fetch(new Request("https://event-runtime/analytics-orchestration-publication", {
        method: "POST",
        headers: eventHeaders,
        body: JSON.stringify(publication),
      }));
      return {
        ok: response.ok,
        status: response.status,
        body: await response.json().catch(() => null),
      };
    });
    if (!publicationResult.ok) {
      if (publicationResult.status === 409) {
        const retryId = await scheduleRetry("event-revision-conflict", null);
        if (retryId) return {
          event_key: eventKey,
          status: "retry_scheduled",
          retry_workflow_id: retryId,
          reason: "event_revision_conflict",
        };
      }
      throw new Error("EventRuntime analytics publication returned HTTP " + publicationResult.status);
    }

    let acknowledgementOutcomes: Array<{ team_key: string; status: number; body: unknown }>;
    try {
      acknowledgementOutcomes = await step.do("acknowledge-published-team-analytics", {
        retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
      }, async () => mapLimit(teamResults, 6, async (result) => {
        const acknowledgement = {
          contract_version: result.contract_version,
          event_key: result.event_key,
          team_key: result.team_key,
          event_source_revision: result.event_source_revision,
          team_source_revision: result.team_source_revision,
          comparison_input_updated_at: result.comparison_input_updated_at,
          team_event_revision: result.team_event_revision,
        };
        const response = await teamNamespace.get(teamNamespace.idFromName(result.team_key)).fetch(
          new Request("https://team-runtime/event-analytics/acknowledge?year=" + year, {
            method: "POST",
            headers: headers(this.env, "X-FieldView-Team-Key", result.team_key),
            body: JSON.stringify(acknowledgement),
          }),
        );
        if (response.status >= 500 || response.status === 408 || response.status === 425 || response.status === 429) {
          throw new Error("TeamRuntime " + result.team_key +
            " publication acknowledgement returned HTTP " + response.status);
        }
        return { team_key: result.team_key, status: response.status, body: await response.json().catch(() => null) };
      }));
    } catch (error) {
      const retryId = await scheduleRetry("team-publication-acknowledgement-failure", null);
      if (retryId) return {
        event_key: eventKey,
        status: "retry_scheduled",
        retry_workflow_id: retryId,
        reason: "team_publication_acknowledgement_failure",
      };
      throw error;
    }
    const staleAcknowledgement = acknowledgementOutcomes.find((item) => item.status === 409);
    if (staleAcknowledgement) {
      const retryId = await scheduleRetry("team-publication-acknowledgement-conflict", null);
      if (retryId) return {
        event_key: eventKey,
        status: "retry_scheduled",
        retry_workflow_id: retryId,
        reason: "team_publication_acknowledgement_conflict",
      };
      throw new Error("TeamRuntime " + staleAcknowledgement.team_key + " publication acknowledgement was stale");
    }
    const failedAcknowledgement = acknowledgementOutcomes.find((item) => item.status < 200 || item.status >= 300);
    if (failedAcknowledgement) {
      throw new Error("TeamRuntime " + failedAcknowledgement.team_key +
        " publication acknowledgement returned HTTP " + failedAcknowledgement.status);
    }

    return {
      event_key: eventKey,
      event_source_revision: eventInput.event_source_revision,
      registered_team_count: registeredTeams.length,
      recalculated_team_count: recalculated.length,
      retained_team_result_count: teamResults.length - recalculated.length,
      published_team_result_count: teamResults.length,
      acknowledged_team_result_count: acknowledgementOutcomes.length,
      event_publication: publicationResult.body,
    };
  }
}
