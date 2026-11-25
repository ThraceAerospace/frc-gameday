import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { RuntimeEnvironment } from "../../fieldview-runtime/src/cloudflare.ts";
import { dispatchRuntime } from "../../fieldview-runtime/src/runtime-dispatch.ts";
import { dispatchRuntimeRefresh, dispatchRuntimeRefreshBatch } from "../../fieldview-runtime/src/runtime-refresh.ts";
import type { TbaEvent } from "./calendar.ts";
import { selectActiveEvents, selectPollingCandidates, selectBudgetedKeys, MAX_EVENT_CANDIDATES_PER_RUN, MAX_TEAM_READINESS_CHECKS_PER_RUN, MAX_TEAM_REFRESH_COMMANDS_PER_RUN } from "./polling-policy.ts";
import { createDiscoveryStoreClient, type DiscoveryStoreClient } from "./discovery-store.ts";

type PollingEnvironment = RuntimeEnvironment;
export interface PollingCoordinatorParameters {
  scheduledAt: number;
  pollTeams?: boolean;
}
interface WeekProjectionPointer {
  runAt: number;
  years: number[];
}
interface WeekProjection {
  evaluatedAt: number;
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
      const pointer = await readJson<WeekProjectionPointer>(store(), "projections/events/this-week/current.json");
      if (!pointer || !Number.isSafeInteger(pointer.runAt) || !Array.isArray(pointer.years) ||
          !pointer.years.includes(current.year) || scheduledAt - pointer.runAt > 8 * 24 * 60 * 60_000 ||
          pointer.runAt > scheduledAt + 5 * 60_000) {
        throw new Error("The current-week event projection is missing or stale; run event discovery/readiness first");
      }
      const projection = await readJson<WeekProjection>(
        store(),
        `projections/events/this-week/${pointer.runAt}/${current.year}.json`,
      );
      if (!projection || !Array.isArray(projection.events)) {
        throw new Error("The published current-week event projection is incomplete");
      }
      return { year: current.year, projectionRunAt: pointer.runAt, events: projection.events };
    });

    const projectionEvents = discovery.events.filter((item) =>
      item && typeof item.key === "string" && item.key.startsWith(String(discovery.year)));
    const allActiveEvents = selectActiveEvents(projectionEvents, scheduledAt);
    const configuredEventInterval = Number(this.env.EVENT_ACTIVE_INTERVAL_MS ?? 5 * 60_000);
    const eventRotationInterval = Number.isFinite(configuredEventInterval) && configuredEventInterval > 0
      ? configuredEventInterval : 5 * 60_000;
    const eventRotationSlot = Math.floor(scheduledAt / eventRotationInterval);
    const eventTargetKeys = new Set(selectBudgetedKeys(
      allActiveEvents.map((item) => item.key), MAX_EVENT_CANDIDATES_PER_RUN, eventRotationSlot,
    ));
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
          let error: string | undefined;
          if (readinessBody.refresh_required === true) {
            const outcome = await dispatchRuntimeRefresh(this.env, {
              kind: "event", key: eventKey, year: discovery.year,
              ...(staleEndpoints.length ? { endpoints: staleEndpoints } : {}),
            });
            eventRefresh = outcome.ok ? "succeeded" : "failed";
            if (!outcome.ok) error = outcome.error ?? "Event refresh failed";
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
      results.push(result);
      for (const teamKey of result.participant_team_keys ?? []) participantTeamKeys.add(teamKey);
    }

    let teamReadinessFailed = 0;
    let teamRefreshesAttempted = 0;
    let teamRefreshesSucceeded = 0;
    let teamRefreshesFailed = 0;
    let readinessDeferredTeamCount = 0;
    if (pollTeams && participantTeamKeys.size > 0) {
      const rosterKeys = [...participantTeamKeys];
      const teamRotationSlot = Math.floor(scheduledAt / (24 * 60 * 60_000));
      const boundedRosterKeys = selectBudgetedKeys(
        rosterKeys, MAX_TEAM_READINESS_CHECKS_PER_RUN, teamRotationSlot,
      );
      const registration = await step.do("check-daily-team-runtime-registration", async () =>
        mapLimit(boundedRosterKeys, 4, async (teamKey) => ({
          teamKey,
          registered: await isRuntimeRegistered(store(), "team", teamKey),
        })),
      );
      const registeredTeamKeys = registration.filter((item) => item.registered).map((item) => item.teamKey);
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
        dispatchRuntimeRefreshBatch(this.env, boundedDueTeams, 4),
      );
      teamRefreshesAttempted = teamOutcomes.length;
      teamRefreshesSucceeded = teamOutcomes.filter((item) => item.ok).length;
      teamRefreshesFailed = teamOutcomes.filter((item) => !item.ok).length;
    }

    return {
      scheduled_at: scheduledAt,
      current_season: discovery.year,
      week_projection_run_at: discovery.projectionRunAt,
      weekly_event_registry_checks: projectionEvents.length,
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
      team_readiness_checks_processed: pollTeams ? Math.min(participantTeamKeys.size, MAX_TEAM_READINESS_CHECKS_PER_RUN) : 0,
      team_readiness_checks_deferred_by_budget: pollTeams ? Math.max(0, participantTeamKeys.size - MAX_TEAM_READINESS_CHECKS_PER_RUN) : 0,
      team_readiness_failed: teamReadinessFailed,
      team_refreshes_deferred_by_budget: pollTeams ? Math.max(0, readinessDeferredTeamCount) : 0,
      team_refreshes_attempted: teamRefreshesAttempted,
      team_refreshes_succeeded: teamRefreshesSucceeded,
      team_refreshes_failed: teamRefreshesFailed,
      results,
    };
  }
}
