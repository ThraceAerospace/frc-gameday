import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { RuntimeEnvironment } from "../runtime/cloudflare.ts";
import { dispatchRuntime } from "../runtime/runtime-dispatch.ts";
import { dispatchRuntimeRefresh, dispatchRuntimeRefreshBatch } from "../runtime/runtime-refresh.ts";
import type { EventAnalyticsRefreshRequest } from "../runtime/runtime-refresh.ts";
import type { TbaEvent } from "./calendar.ts";
import { selectActiveEvents, selectPollingCandidates, selectBudgetedKeys, selectBudgetedItems, MAX_EVENT_CANDIDATES_PER_RUN, MAX_TEAM_READINESS_CHECKS_PER_RUN, MAX_TEAM_REFRESH_COMMANDS_PER_RUN, MAX_PENDING_ANALYTICS_RECOVERY_CHECKS_PER_RUN, MAX_PENDING_ANALYTICS_RECOVERY_EVENTS_PER_RUN } from "./polling-policy.ts";
import { createDiscoveryStoreClient, type DiscoveryStoreClient } from "./discovery-store.ts";
import { utcProjectionWeekWindow } from "./weekly-projection.ts";

type PollingEnvironment = RuntimeEnvironment & { EVENT_ANALYTICS_WORKFLOW?: Workflow };
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
  lifecycle: "active";
  event_refresh: "not_due" | "succeeded" | "failed" | "unavailable";
  participant_team_keys?: string[];
  affected_team_keys?: string[] | null;
  error?: string;
}

async function readJson<T>(store: DiscoveryStoreClient, key: string): Promise<T | null> {
  const object = await store.get(key);
  return object ? object.json<T>() : null;
}

async function isRuntimeRegistered(
  store: DiscoveryStoreClient,
  kind: "event" | "team",
  key: string,
): Promise<boolean> {
  const prefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
  return Boolean(await store.get(prefix + key + ".json"));
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
    const store = () => createDiscoveryStoreClient(this.env.DISCOVERY_STORE);

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
    const allActiveEvents = selectActiveEvents(projectionEvents, scheduledAt);
    const configuredEventInterval = Number(this.env.EVENT_ACTIVE_INTERVAL_MS ?? 5 * 60_000);
    const eventRotationInterval = Number.isFinite(configuredEventInterval) && configuredEventInterval > 0
      ? configuredEventInterval : 5 * 60_000;
    const eventRotationSlot = Math.floor(scheduledAt / eventRotationInterval);
    const eventTargetKeys = new Set(selectBudgetedItems(
      allActiveEvents, MAX_EVENT_CANDIDATES_PER_RUN, eventRotationSlot,
    ).map((item) => item.key));
    const eventRegistrationCandidates = allActiveEvents.filter((item) => eventTargetKeys.has(item.key));
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

    const results: PollingEventResult[] = [];
    const participantTeamKeys = new Set<string>();
    const eventAnalyticsRequests = new Map<string, EventAnalyticsRefreshRequest>();
    for (const candidate of candidates) {
      const eventKey = candidate.event.key;
      const result = await step.do("poll-event-" + eventKey, async (): Promise<PollingEventResult> => {
        try {
          const minimumIntervalMs = Number(this.env.EVENT_ACTIVE_INTERVAL_MS ?? 5 * 60_000);
          const readiness = await dispatchRuntime(this.env, "event", eventKey, "readiness", {
            minimumIntervalMs,
          }, discovery.year);
          if (readiness.status === 204) {
            return { event_key: eventKey, lifecycle: candidate.lifecycle, event_refresh: "unavailable" };
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

          let participantKeys: string[] = [];
          if (pollTeams) {
            // EventRuntime owns the participant resource. The daily team pass
            // asks for the roster once per event, not on every live poll tick.
            const participantsResponse = await dispatchRuntime(this.env, "event", eventKey, "participants", {}, discovery.year);
            if (participantsResponse.ok && participantsResponse.status !== 204) {
              const participants = await participantsResponse.json() as { team_keys?: unknown };
              participantKeys = [...new Set((Array.isArray(participants.team_keys) ? participants.team_keys : [])
                .filter((key): key is string => typeof key === "string" && /^frc[0-9]+$/.test(key)))];
            } else if (!error) {
              error = "Participant roster unavailable (HTTP " + participantsResponse.status + ")";
            }
          }
          return {
            event_key: eventKey,
            lifecycle: candidate.lifecycle,
            event_refresh: eventRefresh,
            ...(participantKeys.length ? { participant_team_keys: participantKeys } : {}),
            ...(affectedTeamKeys !== undefined ? { affected_team_keys: affectedTeamKeys } : {}),
            ...(error ? { error } : {}),
          };
        } catch (error) {
          return {
            event_key: eventKey,
            lifecycle: candidate.lifecycle,
            event_refresh: "failed",
            error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          };
        }
      });
      if (result.event_refresh === "succeeded" &&
          result.affected_team_keys !== undefined &&
          (result.affected_team_keys === null || result.affected_team_keys.length > 0)) {
        eventAnalyticsRequests.set(result.event_key, { affected_team_keys: result.affected_team_keys, poll_cycle_token: scheduledAt });
      }
      results.push(result);
      for (const teamKey of result.participant_team_keys ?? []) participantTeamKeys.add(teamKey);
    }

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
            const response = await dispatchRuntime(this.env, "team", teamKey, "readiness", {}, discovery.year);
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
      eligible_events: allActiveEvents.length,
      event_registry_checks_processed: eventRegistrationCandidates.length,
      event_registry_checks_deferred_by_budget: Math.max(0, allActiveEvents.length - eventRegistrationCandidates.length),
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
