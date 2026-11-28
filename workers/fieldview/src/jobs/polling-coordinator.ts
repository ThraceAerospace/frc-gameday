import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { RuntimeEnvironment } from "../runtime/cloudflare.ts";
import { dispatchRuntime } from "../runtime/runtime-dispatch.ts";
import { dispatchRuntimeRefresh, dispatchRuntimeRefreshBatch } from "../runtime/runtime-refresh.ts";
import type { EventAnalyticsRefreshRequest } from "../runtime/runtime-refresh.ts";
import { isValidEventLifecycleInput } from "./calendar.ts";
import type { TbaEvent } from "./calendar.ts";
import { selectThisWeekEvents, selectPollingCandidates, selectBudgetedKeys, selectBudgetedItems, selectInitialEventCandidates, isEventAnalyticsRecoveryDue, MAX_EVENT_CANDIDATES_PER_RUN, MAX_INITIAL_EVENT_ACQUISITIONS_PER_RUN, MAX_INITIAL_TEAM_ACQUISITIONS_PER_RUN, MAX_TEAM_READINESS_CHECKS_PER_RUN, MAX_TEAM_REFRESH_COMMANDS_PER_RUN, MAX_PENDING_ANALYTICS_RECOVERY_CHECKS_PER_RUN, MAX_PENDING_ANALYTICS_RECOVERY_EVENTS_PER_RUN } from "./polling-policy.ts";
import { createDiscoveryServiceClient, type DiscoveryServiceClient } from "./discovery-client.ts";
import { utcProjectionWeekWindow } from "./weekly-projection.ts";
import { AnalyticsExecutionRepository } from "./analytics-executions.ts";
import { acquireRuntimeBootstrap } from "./runtime-bootstrap-acquisition.ts";

type PollingEnvironment = RuntimeEnvironment & { EVENT_ANALYTICS_WORKFLOW?: Workflow };

const MAX_ANALYTICS_EXECUTION_RECOVERIES_PER_RUN = 5;
const STALE_ANALYTICS_WORKFLOW_MS = 15 * 60_000;

async function recoverAnalyticsExecutions(
  env: PollingEnvironment,
  now: number,
): Promise<{ scanned: number; dispatched: number; reconciled: number; deferred: number }> {
  if (!env.EVENT_ANALYTICS_WORKFLOW || (!env.DB && !env.DISCOVERY_STORAGE)) {
    return { scanned: 0, dispatched: 0, reconciled: 0, deferred: 0 };
  }
  const repository = AnalyticsExecutionRepository.fromEnvironment(env);
  const records = await repository.list(1000);
  let dispatched = 0;
  let reconciled = 0;
  let deferred = 0;

  const readStatus = async (workflowId: string): Promise<string | null> => {
    try {
      return (await env.EVENT_ANALYTICS_WORKFLOW!.get(workflowId).then((instance) => instance.status())).status;
    } catch {
      return null;
    }
  };

  const dispatchRetry = async (
    record: Awaited<ReturnType<typeof repository.list>>[number],
    retryId: string,
    attempt: number,
  ): Promise<void> => {
    await repository.retryScheduled(record.execution_id, retryId, record.workflow_id, now);
    try {
      await env.EVENT_ANALYTICS_WORKFLOW!.create({
        id: retryId,
        params: {
          event_key: record.event_key,
          affected_team_keys: record.affected_team_keys,
          requested_at: record.requested_at,
          retry_key: record.retry_key,
          attempt,
        },
      });
      dispatched += 1;
    } catch {
      // A deterministic Workflow ID makes concurrent coordinator attempts idempotent.
      // If it already exists, its instance status is the source of truth.
      const status = await readStatus(retryId);
      if (status === null) deferred += 1;
    }
  };

  for (const record of records) {
    if (dispatched >= MAX_ANALYTICS_EXECUTION_RECOVERIES_PER_RUN) {
      if (record.status === "failed" || record.status === "retry_scheduled") deferred += 1;
      continue;
    }

    if (record.status === "running" && now - record.updated_at >= STALE_ANALYTICS_WORKFLOW_MS) {
      const status = await readStatus(record.workflow_id);
      if (status === "errored" || status === "terminated") {
        await repository.fail(record.execution_id, new Error("Workflow " + status), record.workflow_id, now);
        reconciled += 1;
      } else if (status === "complete") {
        await repository.complete(record.execution_id, undefined, undefined, record.workflow_id, now);
        reconciled += 1;
      }
      continue;
    }

    if (record.status === "retry_scheduled") {
      const retryId = record.retry_workflow_id;
      if (!retryId) continue;
      const status = await readStatus(retryId);
      const nextAttempt = Math.min(2, record.attempt + 1);
      if (status === null) {
        await dispatchRetry(record, retryId, nextAttempt);
      } else if (status === "errored" || status === "terminated") {
        await repository.start({
          executionId: record.execution_id, eventKey: record.event_key, retryKey: record.retry_key,
          workflowId: retryId, affectedTeamKeys: record.affected_team_keys,
          requestedAt: record.requested_at, attempt: nextAttempt, now,
        });
        await repository.fail(record.execution_id, new Error("Workflow " + status), retryId, now);
        reconciled += 1;
      } else if (status === "complete") {
        await repository.start({
          executionId: record.execution_id, eventKey: record.event_key, retryKey: record.retry_key,
          workflowId: retryId, affectedTeamKeys: record.affected_team_keys,
          requestedAt: record.requested_at, attempt: nextAttempt, now,
        });
        await repository.complete(record.execution_id, undefined, undefined, retryId, now);
        reconciled += 1;
      }
      continue;
    }

    if (record.status === "failed" && record.attempt < 2 &&
        typeof record.next_retry_at === "number" && record.next_retry_at <= now) {
      const nextAttempt = record.attempt + 1;
      const retryId = "event-analytics-" + record.event_key + "-" + record.retry_key + "-retry-" + nextAttempt;
      await dispatchRetry(record, retryId, nextAttempt);
    }
  }

  return { scanned: records.length, dispatched, reconciled, deferred };
}
export interface PollingCoordinatorParameters {
  scheduledAt: number;
  pollTeams?: boolean;
}
interface WeekProjection {
  schemaVersion: 1;
  year: number;
  evaluatedAt: number;
  weekStart: string;
  weekEnd: string;
  checkedAt: number;
  events: TbaEvent[];
}
interface CurrentSeason {
  year: number;
}
interface PollingEventResult {
  event_key: string;
  lifecycle: "active" | "upcoming";
  event_refresh: "not_due" | "succeeded" | "failed" | "unavailable";
  participant_team_keys?: string[];
  affected_team_keys?: string[] | null;
  analytics_recovery?: boolean;
  analytics_revision_part?: string;
  analytics_state_failed?: boolean;
  error?: string;
}

async function readJson<T>(store: DiscoveryServiceClient, key: string): Promise<T | null> {
  return store.get<T>(key);
}

async function isRuntimeRegistered(
  store: DiscoveryServiceClient,
  kind: "event" | "team",
  key: string,
): Promise<boolean> {
  const prefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
  return Boolean(await store.get(prefix + key + ".json"));
}

async function ensureTeamRuntimeRegistered(
  env: PollingEnvironment,
  store: DiscoveryServiceClient,
  teamKey: string,
  year: number,
): Promise<boolean> {
  if (await isRuntimeRegistered(store, "team", teamKey)) return true;
  if (!env.TEAM_RUNTIME) return false;
  const stub = env.TEAM_RUNTIME.get(env.TEAM_RUNTIME.idFromName(teamKey));
  const response = await stub.fetch(new Request("https://team-runtime/register", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN,
      "X-FieldView-Team-Key": teamKey,
    },
  }));
  if (!response.ok) throw new Error("TeamRuntime registration failed for " + teamKey + " with HTTP " + response.status);
  await store.put("registry/runtime-teams/" + teamKey + ".json", JSON.stringify({
    year,
    registered_at: Date.now(),
    source: "active-event-roster",
  }));
  return true;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  callback: (item: T) => Promise<R>,
): Promise<R[]> {
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

/**
 * The coordinator is the only recurring polling owner. It reads the already
 * published weekly discovery projection, inspects registered runtimes, and
 * sends explicit refresh commands. It never fetches provider resources itself.
 */
export class PollingCoordinatorWorkflow extends WorkflowEntrypoint<PollingEnvironment, PollingCoordinatorParameters> {
  async run(
    event: WorkflowEvent<PollingCoordinatorParameters>,
    step: WorkflowStep,
  ): Promise<Record<string, unknown>> {
    const scheduledAt = Number.isSafeInteger(event.payload?.scheduledAt)
      ? event.payload.scheduledAt
      : event.schedule?.scheduledTime ?? Date.now();
    const pollTeams = event.payload?.pollTeams === true;
    const store = () => createDiscoveryServiceClient(this.env);

    const analyticsExecutionRecovery = await step.do("recover-durable-event-analytics-executions", async () =>
      recoverAnalyticsExecutions(this.env, scheduledAt),
    );

    const discovery = await step.do("load-current-season-and-week-projection", async () => {
      const current = await readJson<CurrentSeason>(store(), "discovery/current-season.json");
      if (!current || !Number.isInteger(current.year) || current.year < 1992 || current.year > 2200) {
        throw new Error("The authoritative TBA current-season discovery record is unavailable");
      }
      const projection = await readJson<WeekProjection>(
        store(),
        "projections/events-this-week/current.json",
      );
      const expectedWeek = utcProjectionWeekWindow(scheduledAt);
      if (!projection || projection.schemaVersion !== 1 || projection.year !== current.year ||
          projection.weekStart !== expectedWeek.weekStart || projection.weekEnd !== expectedWeek.weekEnd ||
          !Number.isSafeInteger(projection.evaluatedAt) ||
          projection.evaluatedAt > scheduledAt + 5 * 60_000 || !Number.isFinite(projection.checkedAt) ||
          !Array.isArray(projection.events)) {
        throw new Error("The canonical events-this-week projection is missing, stale, or incomplete; refresh weekly event discovery");
      }
      return { year: current.year, projectionRunAt: projection.evaluatedAt, events: projection.events };
    });

    const projectionEvents = discovery.events.filter((item) =>
      item && typeof item.key === "string" && item.key.startsWith(String(discovery.year)));
    const allThisWeekEvents = selectThisWeekEvents(projectionEvents, scheduledAt);
    const configuredEventInterval = Number(this.env.EVENT_ACTIVE_INTERVAL_MS ?? 5 * 60_000);
    const eventRotationInterval = Number.isFinite(configuredEventInterval) && configuredEventInterval > 0
      ? configuredEventInterval : 5 * 60_000;
    const eventRotationSlot = Math.floor(scheduledAt / eventRotationInterval);
    const eventTargetKeys = new Set(selectBudgetedItems(
      allThisWeekEvents, MAX_EVENT_CANDIDATES_PER_RUN, eventRotationSlot,
    ).map((item) => item.key));
    const eventRegistrationCandidates = allThisWeekEvents.filter((item) => eventTargetKeys.has(item.key));
    const registeredEventKeys = await step.do("check-budgeted-event-runtime-registration", async () => {
      const checks = await mapLimit(eventRegistrationCandidates, 4, async (item) => ({
        key: item.key,
        registered: await isRuntimeRegistered(store(), "event", item.key),
      }));
      return checks.filter((item) => item.registered).map((item) => item.key);
    });
    const registeredEvents = new Set(registeredEventKeys);
    const candidates = selectPollingCandidates(
      eventRegistrationCandidates, registeredEvents, scheduledAt, MAX_EVENT_CANDIDATES_PER_RUN, 0,
    );

    // First-time acquisition is separate from active-event cadence. It scans
    // the canonical season directory but only dispatches a tiny rotating slice
    // whose EventState projection is not currently available.
    const initialEventDirectory = await step.do("load-initial-event-acquisition-directory", async () => {
      const directory = await readJson<{ year?: number; events?: TbaEvent[] }>(
        store(), "discovery/events/" + discovery.year + ".json",
      );
      return directory?.year === discovery.year && Array.isArray(directory.events)
        ? directory.events.filter((item) => item && typeof item.key === "string" &&
          item.key.startsWith(String(discovery.year)) && isValidEventLifecycleInput(item))
        : [];
    });
    const initialEventCandidates = selectInitialEventCandidates(
      initialEventDirectory,
      scheduledAt,
      MAX_INITIAL_EVENT_ACQUISITIONS_PER_RUN,
      Math.floor(scheduledAt / (5 * 60_000)),
      new Set(candidates.map((item) => item.event.key)),
    );
    const initialEventAcquisitions = await step.do("acquire-missing-initial-event-states", { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } }, async () =>
      mapLimit(initialEventCandidates, MAX_INITIAL_EVENT_ACQUISITIONS_PER_RUN, async (item) => {
        if (!await isRuntimeRegistered(store(), "event", item.key)) {
          return { key: item.key, status: "unregistered" as const };
        }
        const readiness = await dispatchRuntime(this.env, "event", item.key, "readiness", {}, discovery.year);
        if (!readiness.ok) throw new Error("Initial EventRuntime readiness failed for " + item.key +
          " with HTTP " + readiness.status);
        const body = await readiness.json() as { state_valid?: unknown; refresh_required?: unknown };
        if (body.state_valid === true) return { key: item.key, status: "already_published" as const };
        if (body.refresh_required !== true) {
          return { key: item.key, status: "not_ready" as const };
        }
        const bootstrapId = "poll:" + scheduledAt + ":event:" + item.key;
        const bundle = await acquireRuntimeBootstrap(this.env, "event", item.key, discovery.year, bootstrapId);
        const outcome = await dispatchRuntime(this.env, "event", item.key, "bootstrap",
          bundle as unknown as Record<string, unknown>, discovery.year);
        if (!outcome.ok) throw new Error("Initial EventRuntime bootstrap failed for " + item.key +
          " with HTTP " + outcome.status + ": " + (await outcome.text().catch(() => "")).slice(0, 180));
        const receipt = await outcome.json() as { accepted?: unknown; resource_status?: unknown };
        if (receipt.accepted !== true) throw new Error("EventRuntime did not confirm bootstrap acceptance for " + item.key);
        return { key: item.key, status: "acquired" as const, resource_status: receipt.resource_status ?? "unknown" };
      }),
    );


    const results: PollingEventResult[] = [];
    const participantTeamKeys = new Set<string>();
    const eventAnalyticsRequests = new Map<string, EventAnalyticsRefreshRequest>();
    const analyticsStateCheckedEventKeys = new Set<string>();
    let eventAnalyticsRecoveryChecksProcessed = 0;
    let eventAnalyticsRecoveryChecksFailed = 0;
    let eventAnalyticsRecoveryRequests = 0;
    for (const candidate of candidates) {
      const eventKey = candidate.event.key;
      const result = await step.do("poll-event-" + eventKey, async (): Promise<PollingEventResult> => {
        try {
          const configuredInterval = Number(candidate.lifecycle === "upcoming"
            ? this.env.EVENT_UPCOMING_INTERVAL_MS ?? 30 * 60_000
            : this.env.EVENT_ACTIVE_INTERVAL_MS ?? 5 * 60_000);
          const defaultInterval = candidate.lifecycle === "upcoming" ? 30 * 60_000 : 5 * 60_000;
          const minimumIntervalMs = Number.isSafeInteger(configuredInterval) &&
            configuredInterval >= 1_000 && configuredInterval <= 24 * 60 * 60_000
            ? configuredInterval : defaultInterval;
          const readiness = await dispatchRuntime(this.env, "event", eventKey, "readiness", {
            minimumIntervalMs,
            require_full_hydration: true,
          }, discovery.year);
          if (readiness.status === 204) {
            return { event_key: eventKey, lifecycle: candidate.lifecycle, event_refresh: "unavailable", analytics_state_failed: true };
          }
          if (!readiness.ok) throw new Error("Event readiness returned HTTP " + readiness.status);
          const readinessBody = await readiness.json() as { refresh_required?: boolean; stale_sources?: unknown };
          const staleEndpoints = Array.isArray(readinessBody.stale_sources)
            ? readinessBody.stale_sources.filter((endpoint): endpoint is string => typeof endpoint === "string")
            : [];
          let eventRefresh: PollingEventResult["event_refresh"] = "not_due";
          let affectedTeamKeys: string[] | null | undefined;
          let error: string | undefined;
          if (readinessBody.refresh_required === true) {
            const outcome = await dispatchRuntimeRefresh(this.env, {
              kind: "event", key: eventKey, year: discovery.year,
              ...(staleEndpoints.length ? { endpoints: staleEndpoints } : {}),
            });
            eventRefresh = outcome.ok ? "succeeded" : "failed";
            if (!outcome.ok) error = outcome.error ?? "Event refresh failed";
            const refreshResponse = outcome.response;
            const affectedValue = refreshResponse && typeof refreshResponse === "object" &&
              !Array.isArray(refreshResponse)
              ? (refreshResponse as Record<string, unknown>).affected_team_keys
              : undefined;
            affectedTeamKeys = Array.isArray(affectedValue)
              ? [...new Set(affectedValue.filter((key): key is string =>
                  typeof key === "string" && /^frc[0-9]+$/.test(key)))].sort()
              : affectedValue === null ? null : undefined;
          }

          const analyticsStateResponse = await dispatchRuntime(this.env, "event", eventKey, "analytics-state", {}, discovery.year);
          let analyticsRecovery = false;
          let analyticsRevisionPart: string | undefined;
          let analyticsStateFailed = !analyticsStateResponse.ok || analyticsStateResponse.status === 204;
          if (analyticsStateResponse.ok && analyticsStateResponse.status !== 204) {
            const analyticsState = await analyticsStateResponse.json().catch(() => null) as {
              event_state_published?: unknown;
              source_revision?: unknown;
              analytics?: { status?: unknown; revision?: unknown; due_at?: unknown; pending_invalidation?: { requested_at?: unknown } | null };
            } | null;
            if (!analyticsState?.analytics || typeof analyticsState.analytics.status !== "string") {
              analyticsStateFailed = true;
            } else {
              analyticsRecovery = analyticsState.event_state_published === true &&
                isEventAnalyticsRecoveryDue(
                  analyticsState.analytics.status, analyticsState.analytics.due_at, Date.now(),
                );
              analyticsRevisionPart = "event-analytics:" + eventKey + ":" +
                String(analyticsState.source_revision ?? "unknown") + ":" +
                String(analyticsState.analytics.revision ?? 0) + ":" +
                analyticsState.analytics.status + ":" +
                String(analyticsState.analytics.due_at ?? "none") + ":" +
                String(analyticsState.analytics.pending_invalidation?.requested_at ?? "none");
            }
          }

          let participantKeys: string[] = [];
          // Roster membership is needed to initialize participating TeamRuntimes
          // as soon as an event enters this-week. EventRuntime owns any provider
          // acquisition required to make its participant resource available.
          const participantsResponse = await dispatchRuntime(this.env, "event", eventKey, "participants", {
            minimumIntervalMs,
          }, discovery.year);
          if (participantsResponse.ok && participantsResponse.status !== 204) {
            const participants = await participantsResponse.json() as { team_keys?: unknown };
            participantKeys = [...new Set((Array.isArray(participants.team_keys) ? participants.team_keys : [])
              .filter((key): key is string => typeof key === "string" && /^frc[0-9]+$/.test(key)))];
          } else if (!error) {
            error = "Participant roster unavailable (HTTP " + participantsResponse.status + ")";
          }
          return {
            event_key: eventKey,
            lifecycle: candidate.lifecycle,
            event_refresh: eventRefresh,
            ...(participantKeys.length ? { participant_team_keys: participantKeys } : {}),
            ...(affectedTeamKeys !== undefined ? { affected_team_keys: affectedTeamKeys } : {}),
            ...(analyticsRecovery ? { analytics_recovery: true } : {}),
            ...(analyticsRevisionPart ? { analytics_revision_part: analyticsRevisionPart } : {}),
            ...(analyticsStateFailed ? { analytics_state_failed: true } : {}),
            ...(error ? { error } : {}),
          };
        } catch (error) {
          return {
            event_key: eventKey,
            lifecycle: candidate.lifecycle,
            event_refresh: "failed",
            analytics_state_failed: true,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          };
        }
      });
      if (!result.analytics_state_failed) analyticsStateCheckedEventKeys.add(result.event_key);
      eventAnalyticsRecoveryChecksProcessed += result.analytics_state_failed ? 0 : 1;
      if (result.analytics_state_failed) eventAnalyticsRecoveryChecksFailed += 1;
      if (result.event_refresh === "succeeded" &&
          result.affected_team_keys !== undefined &&
          (result.affected_team_keys === null || result.affected_team_keys.length > 0)) {
        eventAnalyticsRequests.set(result.event_key, { affected_team_keys: result.affected_team_keys, poll_cycle_token: scheduledAt });
      }
      if (result.analytics_recovery && result.analytics_revision_part) {
        const previous = eventAnalyticsRequests.get(result.event_key);
        eventAnalyticsRequests.set(result.event_key, {
          affected_team_keys: null,
          revision_parts: [...new Set([...(previous?.revision_parts ?? []), result.analytics_revision_part])],
          ...(previous?.poll_cycle_token === undefined ? {} : { poll_cycle_token: previous.poll_cycle_token }),
          recovery: true,
        });
        eventAnalyticsRecoveryRequests += 1;
      }
      results.push(result);
      for (const teamKey of result.participant_team_keys ?? []) participantTeamKeys.add(teamKey);
    }

    // TeamRuntime initialization is lazy and roster-driven. The independent
    // season seed workflow can fill the broader team directory; this coordinator
    // initializes only teams currently named by active EventRuntime rosters.
    const initialTeamCandidates = selectBudgetedKeys(
      [...participantTeamKeys],
      MAX_INITIAL_TEAM_ACQUISITIONS_PER_RUN,
      Math.floor(scheduledAt / (5 * 60_000)),
    );
    const initialTeamAcquisitions = await step.do("acquire-missing-initial-team-states", { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } }, async () =>
      mapLimit(initialTeamCandidates, MAX_INITIAL_TEAM_ACQUISITIONS_PER_RUN, async (teamKey) => {
        if (!await ensureTeamRuntimeRegistered(this.env, store(), teamKey, discovery.year)) {
          return { key: teamKey, status: "unregistered" as const };
        }
        const readiness = await dispatchRuntime(this.env, "team", teamKey, "readiness", {}, discovery.year);
        if (!readiness.ok) throw new Error("Initial TeamRuntime readiness failed for " + teamKey +
          " with HTTP " + readiness.status);
        const body = await readiness.json() as { state_valid?: unknown; refresh_required?: unknown };
        if (body.state_valid === true) return { key: teamKey, status: "already_published" as const };
        if (body.refresh_required !== true) {
          return { key: teamKey, status: "not_ready" as const };
        }
        const bootstrapId = "poll:" + scheduledAt + ":team:" + teamKey;
        const bundle = await acquireRuntimeBootstrap(this.env, "team", teamKey, discovery.year, bootstrapId);
        const outcome = await dispatchRuntime(this.env, "team", teamKey, "bootstrap",
          bundle as unknown as Record<string, unknown>, discovery.year);
        if (!outcome.ok) throw new Error("Initial TeamRuntime bootstrap failed for " + teamKey +
          " with HTTP " + outcome.status + ": " + (await outcome.text().catch(() => "")).slice(0, 180));
        const receipt = await outcome.json() as { accepted?: unknown; resource_status?: unknown };
        if (receipt.accepted !== true) throw new Error("TeamRuntime did not confirm bootstrap acceptance for " + teamKey);
        return { key: teamKey, status: "acquired" as const, resource_status: receipt.resource_status ?? "unknown" };
      }),
    );

    // Reconcile TeamRuntime results that were calculated but never acknowledged
    // after EventRuntime publication. This scan is bounded and rotates across the
    // canonical team directory, independent of whether any provider data changed.
    let pendingAnalyticsRecoveryChecksProcessed = 0;
    let pendingAnalyticsRecoveryChecksFailed = 0;
    let pendingAnalyticsRecoveryTeams = 0;
    let pendingAnalyticsRecoveryEvents = 0;
    let pendingAnalyticsRecoveryEventsDeferred = 0;
    let pendingAnalyticsRecoveryUnregisteredEvents = 0;
    if (this.env.TEAM_RUNTIME) {
      const directory = await step.do("load-pending-analytics-recovery-team-directory", async () =>
        readJson<unknown>(store(), "registry/teams/" + discovery.year + ".json"),
      );
      const allTeamKeys = Array.isArray(directory)
        ? [...new Set(directory.filter((key): key is string => typeof key === "string" && /^frc[0-9]+$/.test(key)))]
        : [];
      const recoverySlot = Math.floor(scheduledAt / (5 * 60_000));
      const recoveryCandidates = selectBudgetedKeys(
        allTeamKeys, MAX_PENDING_ANALYTICS_RECOVERY_CHECKS_PER_RUN, recoverySlot,
      );
      const registration = await step.do("check-pending-analytics-team-runtime-registration", async () =>
        mapLimit(recoveryCandidates, 4, async (teamKey) => {
          try {
            return { teamKey, registered: await isRuntimeRegistered(store(), "team", teamKey), failed: false };
          } catch {
            return { teamKey, registered: false, failed: true };
          }
        }),
      );
      pendingAnalyticsRecoveryChecksFailed += registration.filter((item) => item.failed).length;
      const registeredTeamKeys = registration.filter((item) => item.registered).map((item) => item.teamKey);
      pendingAnalyticsRecoveryChecksProcessed = registeredTeamKeys.length;
      const pendingReads = await step.do("read-pending-team-event-analytics", async () =>
        mapLimit(registeredTeamKeys, 4, async (teamKey) => {
          try {
            const response = await dispatchRuntime(this.env, "team", teamKey, "pending-analytics", {}, discovery.year);
            if (!response.ok) return { teamKey, pending: [], failed: true };
            const body = await response.json() as { team_key?: unknown; year?: unknown; pending?: unknown };
            if (body.team_key !== teamKey || body.year !== discovery.year || !Array.isArray(body.pending)) {
              return { teamKey, pending: [], failed: true };
            }
            const pending = body.pending.filter((item): item is {
              event_key: string; team_event_revision: number; event_source_revision: number;
              team_source_revision: number; comparison_input_updated_at: number;
            } => Boolean(item && typeof item === "object" && !Array.isArray(item) &&
              typeof (item as Record<string, unknown>).event_key === "string" &&
              new RegExp("^" + discovery.year + "[a-zA-Z0-9_-]+$").test(String((item as Record<string, unknown>).event_key)) &&
              ["team_event_revision", "event_source_revision", "team_source_revision", "comparison_input_updated_at"]
                .every((field) => Number.isSafeInteger((item as Record<string, unknown>)[field]))));
            return { teamKey, pending, failed: false };
          } catch {
            return { teamKey, pending: [], failed: true };
          }
        }),
      );
      pendingAnalyticsRecoveryChecksFailed += pendingReads.filter((item) => item.failed).length;
      const pendingByEvent = new Map<string, { teamKeys: Set<string>; revisionParts: Set<string> }>();
      for (const result of pendingReads) {
        for (const item of result.pending) {
          const group = pendingByEvent.get(item.event_key) ?? { teamKeys: new Set<string>(), revisionParts: new Set<string>() };
          group.teamKeys.add(result.teamKey);
          group.revisionParts.add("pending:" + result.teamKey + ":" + item.team_event_revision + ":" +
            item.event_source_revision + ":" + item.team_source_revision + ":" + item.comparison_input_updated_at);
          pendingByEvent.set(item.event_key, group);
        }
      }
      const selectedPendingEventKeys = selectBudgetedKeys(
        [...pendingByEvent.keys()], MAX_PENDING_ANALYTICS_RECOVERY_EVENTS_PER_RUN, recoverySlot,
      );
      pendingAnalyticsRecoveryEventsDeferred = pendingByEvent.size - selectedPendingEventKeys.length;
      const eventRegistration = await step.do("check-pending-analytics-event-runtime-registration", async () =>
        mapLimit(selectedPendingEventKeys, 4, async (eventKey) => {
          try {
            return { eventKey, registered: await isRuntimeRegistered(store(), "event", eventKey) };
          } catch {
            return { eventKey, registered: false };
          }
        }),
      );
      const registeredPendingEvents = new Set(eventRegistration.filter((item) => item.registered).map((item) => item.eventKey));
      pendingAnalyticsRecoveryUnregisteredEvents = eventRegistration.length - registeredPendingEvents.size;
      for (const [eventKey, pending] of pendingByEvent) {
        if (!selectedPendingEventKeys.includes(eventKey)) continue;
        if (!registeredPendingEvents.has(eventKey)) continue;
        const previous = eventAnalyticsRequests.get(eventKey);
        const affected = previous?.affected_team_keys === null
          ? null
          : [...new Set([...(previous?.affected_team_keys ?? []), ...pending.teamKeys])].sort();
        eventAnalyticsRequests.set(eventKey, {
          affected_team_keys: affected,
          ...(previous?.poll_cycle_token === undefined ? {} : { poll_cycle_token: previous.poll_cycle_token }),
          revision_parts: [...new Set([...(previous?.revision_parts ?? []), ...pending.revisionParts])].sort(),
          recovery: true,
        });
      }
      pendingAnalyticsRecoveryTeams = new Set([...registeredPendingEvents].flatMap((eventKey) =>
        [...(pendingByEvent.get(eventKey)?.teamKeys ?? [])])).size;
      pendingAnalyticsRecoveryEvents = registeredPendingEvents.size;
    }

    // EventRuntime analytics publications can remain pending even when the
    // Workflow failed before any TeamRuntime result was written. Scan the
    // registered current-season event owners independently of event lifecycle.
    // This bounded registry pass also recovers completed events after they leave
    // the weekly active-event projection.
    let eventAnalyticsRecoveryEventsDeferred = 0;
    if (this.env.EVENT_RUNTIME) {
      const eventRegistryObjects = await step.do("load-event-analytics-recovery-registry", async () => {
        const keys: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 10; page += 1) {
          const result = await store().list({
            prefix: "registry/runtime-events/" + discovery.year,
            limit: 1000,
            ...(cursor ? { cursor } : {}),
          });
          keys.push(...result.keys);
          if (!result.truncated) return keys;
          if (!result.cursor) throw new Error("Event analytics recovery registry pagination lost its cursor");
          cursor = result.cursor;
        }
        throw new Error("Event analytics recovery registry exceeds the bounded 10,000-record scan");
      });
      const registeredEventKeys = [...new Set(eventRegistryObjects.map((key) =>
        key.slice("registry/runtime-events/".length).replace(/\.json$/, ""),
      ).filter((key) => new RegExp("^" + discovery.year + "[a-zA-Z0-9_-]+$").test(key)))];
      const uncheckedEventKeys = registeredEventKeys.filter((key) => !analyticsStateCheckedEventKeys.has(key));
      const selectedEventKeys = selectBudgetedKeys(
        uncheckedEventKeys, MAX_PENDING_ANALYTICS_RECOVERY_EVENTS_PER_RUN,
        Math.floor(scheduledAt / (5 * 60_000)),
      );
      eventAnalyticsRecoveryEventsDeferred = uncheckedEventKeys.length - selectedEventKeys.length;
      const analyticsStates = await step.do("read-registered-event-analytics-recovery-state", async () =>
        mapLimit(selectedEventKeys, 4, async (eventKey) => {
          try {
            const response = await dispatchRuntime(this.env, "event", eventKey, "analytics-state", {}, discovery.year);
            if (!response.ok) return { eventKey, due: false, failed: true, revisionPart: "" };
            const value = await response.json() as {
              event_state_published?: unknown;
              source_revision?: unknown;
              analytics?: { status?: unknown; revision?: unknown; due_at?: unknown; pending_invalidation?: { requested_at?: unknown } | null };
            };
            if (!value.analytics || typeof value.analytics.status !== "string") {
              return { eventKey, due: false, failed: true, revisionPart: "" };
            }
            const due = value.event_state_published === true &&
              isEventAnalyticsRecoveryDue(value.analytics.status, value.analytics.due_at, Date.now());
            return {
              eventKey, due, failed: false,
              revisionPart: "event-analytics:" + eventKey + ":" +
                String(value.source_revision ?? "unknown") + ":" +
                String(value.analytics.revision ?? 0) + ":" +
                value.analytics.status + ":" +
                String(value.analytics.due_at ?? "none") + ":" +
                String(value.analytics.pending_invalidation?.requested_at ?? "none"),
            };
          } catch {
            return { eventKey, due: false, failed: true, revisionPart: "" };
          }
        }),
      );
      eventAnalyticsRecoveryChecksProcessed += analyticsStates.filter((item) => !item.failed).length;
      eventAnalyticsRecoveryChecksFailed += analyticsStates.filter((item) => item.failed).length;
      for (const item of analyticsStates) {
        if (!item.due || !item.revisionPart) continue;
        const previous = eventAnalyticsRequests.get(item.eventKey);
        eventAnalyticsRequests.set(item.eventKey, {
          affected_team_keys: null,
          revision_parts: [...new Set([...(previous?.revision_parts ?? []), item.revisionPart])],
          ...(previous?.poll_cycle_token === undefined ? {} : { poll_cycle_token: previous.poll_cycle_token }),
          recovery: true,
        });
        eventAnalyticsRecoveryRequests += 1;
      }
    }

    let teamReadinessFailed = 0;
    let teamRefreshesAttempted = 0;
    let teamRefreshesSucceeded = 0;
    let teamRefreshesFailed = 0;
    let readinessDeferredTeamCount = 0;
    let teamRegistryChecksProcessed = 0;
    let teamRegistryChecksDeferredByBudget = 0;
    let teamReadinessChecksProcessed = 0;
    let analyticsDispatchHandled = false;
    if (pollTeams && participantTeamKeys.size > 0) {
      const rosterKeys = [...participantTeamKeys];
      const teamRotationSlot = Math.floor(scheduledAt / (24 * 60 * 60_000));
      const boundedRosterKeys = selectBudgetedKeys(
        rosterKeys, MAX_TEAM_READINESS_CHECKS_PER_RUN, teamRotationSlot,
      );
      teamRegistryChecksProcessed = boundedRosterKeys.length;
      teamRegistryChecksDeferredByBudget = rosterKeys.length - boundedRosterKeys.length;
      const registration = await step.do("check-daily-team-runtime-registration", async () =>
        mapLimit(boundedRosterKeys, 4, async (teamKey) => ({
          teamKey,
          registered: await isRuntimeRegistered(store(), "team", teamKey),
        })),
      );
      const registeredTeamKeys = registration.filter((item) => item.registered).map((item) => item.teamKey);
      teamReadinessChecksProcessed = registeredTeamKeys.length;
      const readiness = await step.do("check-daily-team-runtime-readiness", async () =>
        mapLimit(registeredTeamKeys, 4, async (teamKey) => {
          try {
            const response = await dispatchRuntime(this.env, "team", teamKey, "readiness", {
              require_full_hydration: true,
            }, discovery.year);
            if (response.status === 204) return { teamKey, refresh: false, staleEndpoints: [] as string[], error: undefined as string | undefined };
            if (!response.ok) return { teamKey, refresh: false, staleEndpoints: [] as string[], error: "HTTP " + response.status };
            const body = await response.json() as { refresh_required?: boolean; stale_resources?: unknown };
            const staleEndpoints = Array.isArray(body.stale_resources)
              ? body.stale_resources.filter((endpoint): endpoint is string => typeof endpoint === "string")
              : [];
            return { teamKey, refresh: body.refresh_required === true, staleEndpoints, error: undefined as string | undefined };
          } catch (error) {
            return { teamKey, refresh: false, staleEndpoints: [] as string[], error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
          }
        }),
      );
      teamReadinessFailed = readiness.filter((item) => item.error).length;
      const dueTeams = readiness.filter((item) => item.refresh).map((item) => ({
        kind: "team" as const, key: item.teamKey, year: discovery.year,
        ...(item.staleEndpoints.length ? { endpoints: item.staleEndpoints } : {}),
      }));
      const selectedTeamKeys = new Set(selectBudgetedKeys(
        dueTeams.map((item) => item.key), MAX_TEAM_REFRESH_COMMANDS_PER_RUN, teamRotationSlot,
      ));
      const boundedDueTeams = dueTeams.filter((item) => selectedTeamKeys.has(item.key));
      readinessDeferredTeamCount = dueTeams.length - boundedDueTeams.length;
      const teamOutcomes = await step.do("refresh-due-team-runtimes", async () =>
        dispatchRuntimeRefreshBatch(this.env, boundedDueTeams, 4, {
          additionalAffectedEvents: eventAnalyticsRequests,
          requestedAt: scheduledAt,
        }),
      );
      analyticsDispatchHandled = true;
      teamRefreshesAttempted = teamOutcomes.length;
      teamRefreshesSucceeded = teamOutcomes.filter((item) => item.ok).length;
      teamRefreshesFailed = teamOutcomes.filter((item) => !item.ok).length;
    }

    if (!analyticsDispatchHandled && eventAnalyticsRequests.size > 0) {
      await step.do("start-event-analytics-for-refreshed-events", async () => {
        await dispatchRuntimeRefreshBatch(this.env, [], 4, {
          additionalAffectedEvents: eventAnalyticsRequests,
          requestedAt: scheduledAt,
        });
        return { events: [...eventAnalyticsRequests.keys()].sort() };
      });
    }

    return {
      scheduled_at: scheduledAt,
      current_season: discovery.year,
      week_projection_run_at: discovery.projectionRunAt,
      weekly_event_candidates_total: projectionEvents.length,
      eligible_events: allThisWeekEvents.length,
      initial_event_candidates: initialEventCandidates.length,
      initial_event_states_acquired: initialEventAcquisitions.filter((item) => item.status === "acquired").length,
      initial_event_states_already_published: initialEventAcquisitions.filter((item) => item.status === "already_published").length,
      initial_event_states_unregistered: initialEventAcquisitions.filter((item) => item.status === "unregistered").length,
      initial_team_candidates: initialTeamCandidates.length,
      initial_team_states_acquired: initialTeamAcquisitions.filter((item) => item.status === "acquired").length,
      initial_team_states_already_published: initialTeamAcquisitions.filter((item) => item.status === "already_published").length,
      initial_team_states_unregistered: initialTeamAcquisitions.filter((item) => item.status === "unregistered").length,
      event_registry_checks_processed: eventRegistrationCandidates.length,
      event_registry_checks_deferred_by_budget: Math.max(0, allThisWeekEvents.length - eventRegistrationCandidates.length),
      event_candidates_processed: candidates.length,
      event_candidates_not_registered: eventRegistrationCandidates.length - candidates.length,
      events_refreshed: results.filter((item) => item.event_refresh === "succeeded").length,
      events_not_due: results.filter((item) => item.event_refresh === "not_due").length,
      events_failed: results.filter((item) => item.event_refresh === "failed").length,
      daily_team_poll: pollTeams,
      participant_teams_discovered: participantTeamKeys.size,
      affected_teams_discovered: new Set(results.flatMap((item) => item.affected_team_keys ?? [])).size,
      pending_analytics_recovery_checks_processed: pendingAnalyticsRecoveryChecksProcessed,
      pending_analytics_recovery_checks_failed: pendingAnalyticsRecoveryChecksFailed,
      pending_analytics_recovery_teams: pendingAnalyticsRecoveryTeams,
      pending_analytics_recovery_events: pendingAnalyticsRecoveryEvents,
      pending_analytics_recovery_events_deferred_by_budget: pendingAnalyticsRecoveryEventsDeferred,
      pending_analytics_recovery_unregistered_events: pendingAnalyticsRecoveryUnregisteredEvents,
      analytics_execution_recovery_scanned: analyticsExecutionRecovery.scanned,
      analytics_execution_recovery_dispatched: analyticsExecutionRecovery.dispatched,
      analytics_execution_recovery_reconciled: analyticsExecutionRecovery.reconciled,
      analytics_execution_recovery_deferred: analyticsExecutionRecovery.deferred,
      event_analytics_recovery_checks_processed: eventAnalyticsRecoveryChecksProcessed,
      event_analytics_recovery_checks_failed: eventAnalyticsRecoveryChecksFailed,
      event_analytics_recovery_requests: eventAnalyticsRecoveryRequests,
      event_analytics_recovery_events_deferred_by_budget: eventAnalyticsRecoveryEventsDeferred,
      team_registry_checks_processed: teamRegistryChecksProcessed,
      team_registry_checks_deferred_by_budget: teamRegistryChecksDeferredByBudget,
      team_readiness_checks_processed: teamReadinessChecksProcessed,
      team_readiness_failed: teamReadinessFailed,
      team_refreshes_deferred_by_budget: pollTeams ? Math.max(0, readinessDeferredTeamCount) : 0,
      team_refreshes_attempted: teamRefreshesAttempted,
      team_refreshes_succeeded: teamRefreshesSucceeded,
      team_refreshes_failed: teamRefreshesFailed,
      results,
    };
  }
}
