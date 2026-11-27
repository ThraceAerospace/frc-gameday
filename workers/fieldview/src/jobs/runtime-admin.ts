import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { TBA_ENDPOINTS } from "../../../../packages/providers/tba/src/endpoints.ts";
import type { RuntimeEnvironment } from "../runtime/cloudflare.ts";
import { dispatchRuntime } from "../runtime/runtime-dispatch.ts";
import { createDiscoveryServiceClient, type DiscoveryServiceClient } from "./discovery-client.ts";

interface RuntimeAdminEnvironment extends RuntimeEnvironment {
  EVENT_SEASON_READINESS?: Workflow;
  TEAM_SEASON_READINESS?: Workflow;
}
export interface RuntimeAdminParameters {
  operation: "team-seed" | "event-team-seed" | "season-ingest";
  workflowId: string;
  year: number;
  requestedAt: number;
  teamKey?: string;
  eventKey?: string;
}
interface RuntimeAdminRecord {
  workflow_id: string; operation: RuntimeAdminParameters["operation"]; year: number;
  status: "running" | "completed" | "completed_with_errors" | "failed" | "cancelled";
  phase: string; processed: number; total: number; started_at: number; updated_at: number;
  counts: Record<string, number>; errors: Array<{ key: string; detail: string; at: number }>;
  team_key?: string; event_key?: string; stage?: string; registered_events?: number;
  seeded_teams?: number; failed_teams?: number; historical_events_registered?: number;
  team_keys?: string[]; cursor?: number; active_team_key?: string | null; team_seed_requests_accepted?: number;
}
interface EventDirectory { year: number; events: Array<{ key: string; start_date: string; end_date: string; timezone: string }> }
const json = (value: unknown) => JSON.stringify(value);
const recordKey = (id: string) => "admin/runtime-jobs/" + id + ".json";

async function read<T>(bucket: DiscoveryServiceClient, key: string): Promise<T | null> {
  return bucket.get<T>(key);
}
async function write(bucket: DiscoveryServiceClient, key: string, value: unknown): Promise<void> {
  await bucket.put(key, json(value));
}
async function dispatch(env: RuntimeAdminEnvironment, kind: "team" | "event", key: string, action: string, body: Record<string, unknown> = {}, year?: number): Promise<Response> {
  const targetYear = year ?? (typeof body.year === "number" ? body.year : undefined);
  return dispatchRuntime(env, kind, key, action, body, targetYear);
}
function validTeam(key: unknown): key is string { return typeof key === "string" && /^frc\d+$/.test(key); }
function validEvent(key: unknown): key is string { return typeof key === "string" && /^[a-zA-Z0-9_-]+$/.test(key); }

export class RuntimeAdminWorkflow extends WorkflowEntrypoint<RuntimeAdminEnvironment, RuntimeAdminParameters> {
  async run(event: WorkflowEvent<RuntimeAdminParameters>, step: WorkflowStep): Promise<RuntimeAdminRecord> {
    const p = event.payload;
    const key = recordKey(p.workflowId);
    const initial = await step.do("load-runtime-admin-job", async () => read<RuntimeAdminRecord>(createDiscoveryServiceClient(this.env), key));
    if (!initial) throw new Error("Runtime admin job record is missing");
    const update = async (patch: Partial<RuntimeAdminRecord>) => {
      const current = await read<RuntimeAdminRecord>(createDiscoveryServiceClient(this.env), key);
      if (!current || current.status !== "running") return current;
      const next = {
        ...current, ...patch,
        ...(patch.phase === undefined ? {} : { stage: patch.phase }),
        ...(current.operation === "event-team-seed" && patch.processed !== undefined
          ? { cursor: patch.processed } : {}),
        ...(current.operation === "team-seed" && patch.processed !== undefined
          ? { registered_events: patch.processed } : {}),
        updated_at: Date.now(),
      };
      await write(createDiscoveryServiceClient(this.env), key, next);
      return next;
    };
    const fail = async (detail: string) => {
      const current = await read<RuntimeAdminRecord>(createDiscoveryServiceClient(this.env), key);
      if (current?.status === "running") await write(createDiscoveryServiceClient(this.env), key, {
        ...current, status: "failed", phase: "failed", stage: "failed", updated_at: Date.now(),
        ...(current.operation === "event-team-seed"
          ? { failed_teams: Math.max(0, current.total - (current.seeded_teams ?? 0)) } : {}),
        errors: [...current.errors, { key: p.workflowId, detail: detail.slice(0, 400), at: Date.now() }].slice(-100),
      });
    };
    try {
      if (p.operation === "team-seed") return await this.seedTeam(p, step, update);
      if (p.operation === "event-team-seed") return await this.seedEventTeams(p, step, update);
      return await this.ingestSeason(p, step, update);
    } catch (error) {
      await fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async seedTeam(
    p: RuntimeAdminParameters, step: WorkflowStep,
    update: (patch: Partial<RuntimeAdminRecord>) => Promise<RuntimeAdminRecord | null>,
  ): Promise<RuntimeAdminRecord> {
    const teamKey = p.teamKey!;
    if (!validTeam(teamKey)) throw new Error("Invalid team key");
    await step.do("dispatch-team-runtime-seed", async () => {
      const response = await dispatch(this.env, "team", teamKey, "seed", { year: p.year });
      if (!response.ok && response.status !== 202) throw new Error("TeamRuntime seed returned HTTP " + response.status);
      return { queued: true };
    });
    await update({ phase: "waiting-for-team-history" });
    const historyEndpoint = TBA_ENDPOINTS.teamEvents(teamKey, p.year);
    let snapshot: { events?: Array<Record<string, unknown>> | null } | null = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const state = await step.do("team-state-" + attempt, async () => {
        const response = await dispatch(this.env, "team", teamKey, "state", { year: p.year });
        if (!response.ok) throw new Error("TeamRuntime state returned HTTP " + response.status);
        return response.json() as Promise<{ endpoints?: Array<{ endpoint?: string; status?: string; last_fetched_at?: number | null; lastFetchedAt?: number | null }> }>;
      });
      const history = state.endpoints?.find((item) => item.endpoint === historyEndpoint);
      if (history?.status === "unavailable") throw new Error("Team event history is unavailable from TBA");
      if ((history?.last_fetched_at ?? history?.lastFetchedAt) != null) {
        const result = await step.do("team-season-snapshot", async () => {
          const response = await dispatch(this.env, "team", teamKey, "snapshot", { year: p.year });
          if (!response.ok) throw new Error("TeamRuntime snapshot returned HTTP " + response.status);
          return response.json() as Promise<{ events?: Array<Record<string, unknown>> | null }>;
        });
        snapshot = result;
        break;
      }
      await step.sleep("wait-team-history-" + attempt, "5 seconds");
    }
    if (!snapshot || !Array.isArray(snapshot.events)) throw new Error("Timed out waiting for TeamRuntime event history");
    const events = snapshot.events.filter((item) => validEvent(item.key));
    await update({ phase: "registering-team-events", total: events.length });
    let registered = 0;
    for (let offset = 0; offset < events.length; offset += 10) {
      const batch = events.slice(offset, offset + 10);
      const registeredInBatch = await step.do("register-team-events-" + offset, async () => {
        let count = 0;
        for (const item of batch) {
          const eventKey = String(item.key);
          const eventYear = Number(eventKey.slice(0, 4));
          if (!Number.isInteger(eventYear) || eventYear < 1992 || eventYear > 2200) continue;
          const response = await dispatch(this.env, "event", eventKey, "register", {}, eventYear);
          if (!response.ok) throw new Error("Event registration returned HTTP " + response.status);
          count += 1;
        }
        return count;
      });
      registered += registeredInBatch;
      await update({ processed: registered });
    }
    const current = await read<RuntimeAdminRecord>(createDiscoveryServiceClient(this.env), recordKey(p.workflowId));
    const completed = { ...(current ?? initialRecord(p)), status: "completed" as const, phase: "complete",
      stage: "complete", team_key: teamKey, registered_events: registered, processed: registered, updated_at: Date.now() };
    await write(createDiscoveryServiceClient(this.env), recordKey(p.workflowId), completed);
    return completed;
  }

  private async seedEventTeams(
    p: RuntimeAdminParameters, step: WorkflowStep,
    update: (patch: Partial<RuntimeAdminRecord>) => Promise<RuntimeAdminRecord | null>,
  ): Promise<RuntimeAdminRecord> {
    const eventKey = p.eventKey!;
    if (!validEvent(eventKey)) throw new Error("Invalid event key");
    let teamKeys: string[] = [];
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const result = await step.do("event-participants-" + attempt, async () => {
        const response = await dispatch(this.env, "event", eventKey, "participants", {}, p.year);
        if (response.status === 202) return { ready: false, team_keys: [] as string[] };
        if (!response.ok) throw new Error("EventRuntime participants returned HTTP " + response.status);
        return response.json() as Promise<{ ready: boolean; team_keys: string[] }>;
      });
      if (result.ready) { teamKeys = [...new Set(result.team_keys.filter(validTeam))]; break; }
      await step.sleep("wait-event-participants-" + attempt, "30 seconds");
    }
    if (!teamKeys.length) throw new Error("Timed out waiting for event participant roster");
    await update({ phase: "seeding-event-teams", total: teamKeys.length, team_keys: teamKeys });
    let processed = 0;
    for (let offset = 0; offset < teamKeys.length; offset += 100) {
      const batch = teamKeys.slice(offset, offset + 100);
      await step.do("dispatch-event-team-batch-" + offset, async () => {
        const results = await Promise.all(batch.map(async (teamKey) => {
          const response = await dispatch(this.env, "team", teamKey, "seed", { year: p.year });
          return { teamKey, ok: response.ok || response.status === 202, status: response.status };
        }));
        const failed = results.filter((item) => !item.ok);
        if (failed.length) throw new Error("TeamRuntime seed failed for " + failed.map((item) => item.teamKey + " (" + item.status + ")").join(", "));
        return results.length;
      });
      processed += batch.length;
      await update({ processed, team_seed_requests_accepted: processed });
    }

    // Seeding is not complete merely because the requests were accepted. Wait
    // for each participant's authoritative event-history resource before registering
    // the historical event identities associated with that team.
    processed = 0;
    const failedTeams = new Set<string>();
    const jobErrors: Array<{ key: string; detail: string; at: number }> = [];
    for (let offset = 0; offset < teamKeys.length; offset += 100) {
      const batch = teamKeys.slice(offset, offset + 100);
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const result = await step.do("verify-participant-history-" + offset + "-" + attempt, async () => {
          const statuses = await Promise.all(batch.map(async (teamKey) => {
            const response = await dispatch(this.env, "team", teamKey, "state", {}, p.year);
            if (!response.ok) return { teamKey, ready: false, failed: false };
            const state = await response.json() as { endpoints?: Array<{ endpoint?: string; status?: string; last_fetched_at?: number | null; lastFetchedAt?: number | null }> };
            const endpoint = TBA_ENDPOINTS.teamEvents(teamKey, p.year);
            const source = state.endpoints?.find((item) => item.endpoint === endpoint);
            if (source?.status === "unavailable") return { teamKey, ready: true, failed: true };
            return { teamKey, ready: (source?.last_fetched_at ?? source?.lastFetchedAt) != null, failed: false };
          }));
          return statuses;
        });
        if (result.every((item) => item.ready)) {
          for (const item of result) {
            if (item.failed) {
              failedTeams.add(item.teamKey);
              jobErrors.push({ key: item.teamKey, detail: "Team event history is unavailable from TBA", at: Date.now() });
            }
          }
          processed = Math.min(teamKeys.length, offset + batch.length);
          await update({
            processed, seeded_teams: processed - failedTeams.size, failed_teams: failedTeams.size,
            errors: jobErrors.slice(-100),
          });
          break;
        }
        if (attempt === 179) throw new Error("Timed out waiting for participant team event histories");
        await step.sleep("wait-participant-history-" + offset + "-" + attempt, "5 seconds");
      }
    }
    const historicalEvents = new Set<string>();
    const successfulTeamKeys = teamKeys.filter((teamKey) => !failedTeams.has(teamKey));
    for (let offset = 0; offset < successfulTeamKeys.length; offset += 100) {
      const batch = successfulTeamKeys.slice(offset, offset + 100);
      const history = await step.do("read-participant-histories-" + offset, async () => {
        const results = await Promise.all(batch.map(async (teamKey) => {
          const response = await dispatch(this.env, "team", teamKey, "snapshot", {}, p.year);
          if (!response.ok) throw new Error("TeamRuntime snapshot failed for " + teamKey);
          const snapshot = await response.json() as { events?: Array<Record<string, unknown>> | null };
          return (snapshot.events ?? []).flatMap((item) => validEvent(item.key) ? [item.key] : []);
        }));
        return results.flat();
      });
      for (const eventKey of history) historicalEvents.add(eventKey);
    }
    const historical = [...historicalEvents];
    let historicalRegistered = 0;
    for (let offset = 0; offset < historical.length; offset += 10) {
      const batch = historical.slice(offset, offset + 10);
      const registeredInBatch = await step.do("register-participant-history-" + offset, async () => {
        let count = 0;
        for (const key of batch) {
          const eventYear = Number(key.slice(0, 4));
          if (!Number.isInteger(eventYear) || eventYear < 1992 || eventYear > 2200) continue;
          const response = await dispatch(this.env, "event", key, "register", {}, eventYear);
          if (!response.ok) throw new Error("Unable to register historical event " + key);
          count += 1;
        }
        return count;
      });
      historicalRegistered += registeredInBatch;
    }
    const current = await read<RuntimeAdminRecord>(createDiscoveryServiceClient(this.env), recordKey(p.workflowId));
    const completed = { ...(current ?? initialRecord(p)),
      status: failedTeams.size > 0 ? "completed_with_errors" as const : "completed" as const,
      phase: "complete", stage: "complete", event_key: eventKey, team_keys: teamKeys, cursor: processed,
      seeded_teams: processed - failedTeams.size, failed_teams: failedTeams.size,
      historical_events_registered: historicalRegistered, errors: jobErrors.slice(-100),
      processed, updated_at: Date.now() };
    await write(createDiscoveryServiceClient(this.env), recordKey(p.workflowId), completed);
    return completed;
  }

  private async ingestSeason(
    p: RuntimeAdminParameters, step: WorkflowStep,
    update: (patch: Partial<RuntimeAdminRecord>) => Promise<RuntimeAdminRecord | null>,
  ): Promise<RuntimeAdminRecord> {
    const events = await read<EventDirectory>(createDiscoveryServiceClient(this.env), "discovery/events/" + p.year + ".json");
    const teams = await read<string[]>(createDiscoveryServiceClient(this.env), "registry/teams/" + p.year + ".json");
    if (!events || events.year !== p.year || !Array.isArray(events.events) || !Array.isArray(teams) || !teams.length) {
      throw new Error("Complete event and team discovery for " + p.year + " before season readiness");
    }
    const teamKeys = [...new Set(teams.filter(validTeam))];
    const eventKeys = [...new Set(events.events.map((item) => item.key).filter(validEvent))];
    if (!teamKeys.length || !eventKeys.length) throw new Error("Discovered season inventory is empty");

    const teamWorkflow = this.env.TEAM_SEASON_READINESS;
    const eventWorkflow = this.env.EVENT_SEASON_READINESS;
    if (!teamWorkflow || !eventWorkflow) {
      throw new Error("Season readiness Workflow bindings are unavailable");
    }

    const requestedAt = Date.now();
    const teamWorkflowId = p.workflowId + "-team-readiness";
    const eventWorkflowId = p.workflowId + "-event-readiness";
    await update({
      phase: "dispatching-season-readiness",
      total: teamKeys.length + eventKeys.length,
      counts: {
        teams_discovered: teamKeys.length,
        events_discovered: eventKeys.length,
        readiness_workflows_dispatched: 0,
      },
    });

    // Season Ingest is a convenience launcher only. The independent,
    // year-scoped readiness Workflows inspect their own entities and dispatch
    // refreshes; this Workflow must not poll for TeamState/EventState completion.
    const outcomes = await step.do("dispatch-independent-season-readiness", async () => {
      const results = await Promise.allSettled([
        teamWorkflow.create({
          id: teamWorkflowId,
          params: { year: p.year, requestedAt },
        }),
        eventWorkflow.create({
          id: eventWorkflowId,
          params: { year: p.year, requestedAt },
        }),
      ]);
      return results.map((result, index) => ({
        kind: index === 0 ? "team" : "event",
        workflow_id: index === 0 ? teamWorkflowId : eventWorkflowId,
        ok: result.status === "fulfilled",
        error: result.status === "rejected"
          ? (result.reason instanceof Error ? result.reason.message : String(result.reason)).slice(0, 400)
          : null,
      }));
    });

    const errors = outcomes.filter((item) => !item.ok).map((item) => ({
      key: item.kind,
      detail: item.error ?? "Unable to dispatch season readiness Workflow",
      at: Date.now(),
    }));
    const counts = {
      teams_discovered: teamKeys.length,
      events_discovered: eventKeys.length,
      readiness_workflows_dispatched: outcomes.filter((item) => item.ok).length,
    };
    const current = await read<RuntimeAdminRecord>(createDiscoveryServiceClient(this.env), recordKey(p.workflowId));
    const completed: RuntimeAdminRecord = {
      ...(current ?? initialRecord(p)),
      status: errors.length ? "completed_with_errors" : "completed",
      phase: "readiness-dispatched",
      processed: counts.readiness_workflows_dispatched,
      total: 2,
      counts,
      errors,
      updated_at: Date.now(),
    };
    await write(createDiscoveryServiceClient(this.env), recordKey(p.workflowId), {
      ...completed,
      readiness_workflows: outcomes,
    });
    return completed;
  }
}
function initialRecord(p: RuntimeAdminParameters): RuntimeAdminRecord {
  return { workflow_id: p.workflowId, operation: p.operation, year: p.year, status: "running",
    phase: "starting", stage: "starting", processed: 0, total: 0, started_at: p.requestedAt, updated_at: p.requestedAt,
    ...(p.teamKey ? { team_key: p.teamKey } : {}),
    ...(p.eventKey ? { event_key: p.eventKey, seeded_teams: 0, failed_teams: 0, historical_events_registered: 0 } : {}),
    counts: {}, errors: [] };
}
