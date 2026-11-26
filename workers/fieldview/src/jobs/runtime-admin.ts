import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { TBA_ENDPOINTS } from "../../../../packages/providers/tba/src/endpoints.ts";
import type { RuntimeEnvironment } from "../runtime/cloudflare.ts";
import { dispatchRuntime } from "../runtime/runtime-dispatch.ts";
import { createDiscoveryServiceClient, type DiscoveryServiceClient } from "./discovery-client.ts";

type RuntimeAdminEnvironment = RuntimeEnvironment;
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
  team_keys?: string[]; cursor?: number; active_team_key?: string | null; queued_teams?: number;
}
interface EventDirectory { year: number; events: Array<{ key: string; start_date: string; end_date: string; timezone: string }> }
const json = (value: unknown) => JSON.stringify(value);
const recordKey = (id: string) => "admin/runtime-jobs/" + id + ".json";

async function read<T>(bucket: DiscoveryServiceClient, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? object.json<T>() : null;
}
async function write(bucket: DiscoveryServiceClient, key: string, value: unknown): Promise<void> {
  await bucket.put(key, json(value), { httpMetadata: { contentType: "application/json" } });
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
    await step.do("enqueue-team-runtime-seed", async () => {
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
      await step.do("enqueue-event-team-batch-" + offset, async () => {
        const results = await Promise.all(batch.map(async (teamKey) => {
          const response = await dispatch(this.env, "team", teamKey, "seed", { year: p.year });
          return { teamKey, ok: response.ok || response.status === 202, status: response.status };
        }));
        const failed = results.filter((item) => !item.ok);
        if (failed.length) throw new Error("TeamRuntime seed failed for " + failed.map((item) => item.teamKey + " (" + item.status + ")").join(", "));
        return results.length;
      });
      processed += batch.length;
      await update({ processed, queued_teams: processed });
    }

    // Seeding is not complete merely because the requests were queued. Wait for
    // each participant's authoritative event-history resource before scheduling
    // the historical events associated with that team.
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
    if (!events || !Array.isArray(events.events) || !Array.isArray(teams) || !teams.length) {
      throw new Error("Complete event and team discovery before season ingestion");
    }
    const teamKeys = [...new Set(teams.filter(validTeam))].sort();
    const eventKeys = [...new Set(events.events.map((item) => item.key).filter(validEvent))].sort();
    if (!teamKeys.length || !eventKeys.length) throw new Error("Discovered season inventory is empty");
    const batchSize = 100;
    const counts: Record<string, number> = {
      teams_queued: 0, teams_complete: 0, teams_partial: 0, events_queued: 0,
      events_complete: 0, events_partial: 0, analytics_succeeded: 0, analytics_partial: 0, analytics_failed: 0,
    };
    const errors: Array<{ key: string; detail: string; at: number }> = [];
    await update({ phase: "queueing-team-resources", total: teamKeys.length + eventKeys.length, counts });

    // Dispatch bounded seed commands. Each TeamRuntime owns its provider acquisition
    // and canonical persistence; the Workflow tracks durable progress only.
    for (let offset = 0; offset < teamKeys.length; offset += batchSize) {
      const batch = teamKeys.slice(offset, offset + batchSize);
      const result = await step.do("queue-season-team-batch-" + offset, async () => Promise.all(batch.map(async (teamKey) => {
        const response = await dispatch(this.env, "team", teamKey, "seed", {}, p.year);
        return { key: teamKey, ok: response.ok || response.status === 202, status: response.status };
      })));
      for (const item of result) if (item.ok) counts.teams_queued += 1;
      else errors.push({ key: item.key, detail: "TeamRuntime seed returned HTTP " + item.status, at: Date.now() });
      await update({ processed: counts.teams_queued, counts, errors: errors.slice(-100) });
    }

    // One Workflow step checks a bounded batch. A single durable sleep separates
    // whole passes, keeping the 8k-entity worst case comfortably below the
    // Workers Free daily Workflow-step budget.
    const readyTeams = new Set<string>();
    await update({ phase: "waiting-for-team-resources" });
    let teamsReady = false;
    for (let pass = 0; pass < 24 * 30; pass += 1) {
      for (let offset = 0; offset < teamKeys.length; offset += batchSize) {
        const batch = teamKeys.slice(offset, offset + batchSize).filter((key) => !readyTeams.has(key));
        if (!batch.length) continue;
        const result = await step.do("check-season-team-pass-" + pass + "-batch-" + offset, async () => {
          const statuses = await Promise.all(batch.map(async (teamKey) => {
            const response = await dispatch(this.env, "team", teamKey, "state", {}, p.year);
            if (!response.ok) return { key: teamKey, ready: false, partial: true };
            const state = await response.json() as {
              resources?: Array<{ endpoint?: string; status?: string; last_fetched_at?: number | null; expires_at?: number | null }>;
            };
            const sources = state.resources ?? [];
            const ready = sources.length > 0 && sources.every((source) =>
              source.status === "unavailable" ||
              (source.status === "available" && source.last_fetched_at != null &&
                (source.expires_at == null || source.expires_at > Date.now())));
            const partial = sources.some((item) => item.status === "unavailable" || item.status === "failed" || item.status === "stale");
            return { key: teamKey, ready, partial };
          }));
          const ready = statuses.filter((item) => item.ready);
          await Promise.all(ready.map(async (item) => {
            const response = await dispatch(this.env, "team", item.key, "snapshot", {}, p.year);
            if (!response.ok) throw new Error("TeamRuntime snapshot failed for " + item.key);
          }));
          return statuses;
        });
        for (const item of result) {
          if (!item.ready || readyTeams.has(item.key)) continue;
          readyTeams.add(item.key);
          if (item.partial) counts.teams_partial += 1;
          else counts.teams_complete += 1;
        }
      }
      await update({ processed: counts.teams_queued, counts, errors: errors.slice(-100) });
      teamsReady = readyTeams.size === teamKeys.length;
      if (teamsReady) break;
      if (pass === 24 * 30 - 1) break;
      await step.sleep("wait-season-team-pass-" + pass, "1 hour");
    }
    if (!teamsReady) {
      for (const key of teamKeys) if (!readyTeams.has(key)) errors.push({
        key, detail: "TeamRuntime resources remain pending after 30 days", at: Date.now(),
      });
      const current = await read<RuntimeAdminRecord>(createDiscoveryServiceClient(this.env), recordKey(p.workflowId));
      const failed: RuntimeAdminRecord = {
        ...(current ?? initialRecord(p)), status: "completed_with_errors", phase: "team-resources-incomplete",
        processed: readyTeams.size, counts, errors: errors.slice(-100), updated_at: Date.now(),
      };
      await write(createDiscoveryServiceClient(this.env), recordKey(p.workflowId), failed);
      return failed;
    }

    await update({ phase: "queueing-event-resources" });
    for (let offset = 0; offset < eventKeys.length; offset += batchSize) {
      const batch = eventKeys.slice(offset, offset + batchSize);
      const result = await step.do("queue-season-event-batch-" + offset, async () => Promise.all(batch.map(async (eventKey) => {
        const response = await dispatch(this.env, "event", eventKey, "refresh", {}, p.year);
        return { key: eventKey, ok: response.ok || response.status === 202, status: response.status };
      })));
      for (const item of result) if (item.ok) counts.events_queued += 1;
      else errors.push({ key: item.key, detail: "EventRuntime refresh returned HTTP " + item.status, at: Date.now() });
      await update({ processed: counts.teams_queued + counts.events_queued, counts, errors: errors.slice(-100) });
    }

    // Event resources, EventState, and analytics are checked in bounded
    // passes. A runtime is not marked complete merely because refresh
    // was accepted; all its required sources and analytics must reach a terminal
    // state first.
    const readyEvents = new Set<string>();
    const analyticsRequested = new Set<string>();
    await update({ phase: "waiting-for-event-resources-and-analytics" });
    let eventsReady = false;
    for (let pass = 0; pass < 6 * 24 * 30; pass += 1) {
      for (let offset = 0; offset < eventKeys.length; offset += batchSize) {
        const batch = eventKeys.slice(offset, offset + batchSize).filter((key) => !readyEvents.has(key));
        if (!batch.length) continue;
        const result = await step.do("check-season-event-pass-" + pass + "-batch-" + offset, async () => {
          const outcomes = await Promise.all(batch.map(async (eventKey) => {
            const response = await dispatch(this.env, "event", eventKey, "state", {}, p.year);
            if (!response.ok) return { key: eventKey, ready: false, requested: false, analytics: "failed", partial: true };
            const state = await response.json() as {
              resources?: Array<{ endpoint?: string; status?: string; last_fetched_at?: number | null; last_webhook_at?: number | null; expires_at?: number | null }>;
              analytics?: { status?: string };
            };
            const sources = state.resources ?? [];
            const resourcesReady = sources.length > 0 && sources.every((source) =>
              source.status === "unavailable" ||
              (source.status === "available" && (source.last_fetched_at != null || source.last_webhook_at != null) &&
                (source.expires_at == null || source.expires_at > Date.now())));
            const partial = sources.some((item) =>
              item.status === "unavailable" || item.status === "failed" || item.status === "stale");
            if (!resourcesReady) return { key: eventKey, ready: false, requested: false, analytics: "pending", partial };
            if (!analyticsRequested.has(eventKey)) {
              const publication = await dispatch(this.env, "event", eventKey, "publish", {}, p.year);
              if (!publication.ok) throw new Error("EventState publication failed for " + eventKey);
              const calculation = await dispatch(this.env, "event", eventKey, "recalculate", { allowPartialTeamStates: true }, p.year);
              if (!calculation.ok && calculation.status !== 202) throw new Error("EventAnalytics request failed for " + eventKey);
              return { key: eventKey, ready: false, requested: true, analytics: "pending", partial };
            }
            const analytics = state.analytics?.status ?? "pending";
            if (!["succeeded", "partial", "failed"].includes(analytics)) {
              return { key: eventKey, ready: false, requested: true, analytics, partial };
            }
            return { key: eventKey, ready: true, requested: true, analytics, partial };
          }));
          return outcomes;
        });
        for (const item of result) {
          if (item.requested) analyticsRequested.add(item.key);
          if (!item.ready || readyEvents.has(item.key)) continue;
          readyEvents.add(item.key);
          if (item.partial || item.analytics === "partial") counts.events_partial += 1;
          else counts.events_complete += 1;
          if (item.analytics === "succeeded") counts.analytics_succeeded += 1;
          else if (item.analytics === "partial") counts.analytics_partial += 1;
          else {
            counts.analytics_failed += 1;
            errors.push({ key: item.key, detail: "EventAnalytics calculation failed", at: Date.now() });
          }
        }
      }
      await update({ processed: counts.teams_queued + readyEvents.size, counts, errors: errors.slice(-100) });
      eventsReady = readyEvents.size === eventKeys.length;
      if (eventsReady) break;
      if (pass === 6 * 24 * 30 - 1) break;
      await step.sleep("wait-season-event-pass-" + pass, "10 minutes");
    }

    const current = await read<RuntimeAdminRecord>(createDiscoveryServiceClient(this.env), recordKey(p.workflowId));
    if (!eventsReady) {
      for (const key of eventKeys) if (!readyEvents.has(key)) errors.push({
        key, detail: "EventRuntime resources or analytics remain pending after 30 days", at: Date.now(),
      });
    }
    const hasErrors = errors.length > 0 || counts.teams_partial > 0 || counts.events_partial > 0 || !eventsReady;
    const completed: RuntimeAdminRecord = {
      ...(current ?? initialRecord(p)), status: hasErrors ? "completed_with_errors" : "completed",
      phase: eventsReady ? "complete" : "event-resources-incomplete",
      processed: counts.teams_queued + readyEvents.size, counts, errors: errors.slice(-100), updated_at: Date.now(),
    };
    await write(createDiscoveryServiceClient(this.env), recordKey(p.workflowId), completed);
    return completed;
  }
}
function initialRecord(p: RuntimeAdminParameters): RuntimeAdminRecord {
  return { workflow_id: p.workflowId, operation: p.operation, year: p.year, status: "running",
    phase: "queued", stage: "queued", processed: 0, total: 0, started_at: p.requestedAt, updated_at: p.requestedAt,
    ...(p.teamKey ? { team_key: p.teamKey } : {}),
    ...(p.eventKey ? { event_key: p.eventKey, seeded_teams: 0, failed_teams: 0, historical_events_registered: 0 } : {}),
    counts: {}, errors: [] };
}
