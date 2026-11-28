import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { RuntimeEnvironment } from "../runtime/cloudflare.ts";
import { dispatchRuntime } from "../runtime/runtime-dispatch.ts";
import { createDiscoveryServiceClient } from "./discovery-client.ts";
import { acquireRuntimeBootstrap } from "./runtime-bootstrap-acquisition.ts";

type RefreshKind = "event" | "team";

type SeasonWorkflowInput = { year: number; requestedAt?: number; eventKeys?: string[] };
type ResolverInput = { requestedAt?: number };

export interface SeasonEnvironment extends RuntimeEnvironment {
  SEASON_DISCOVERY: Workflow;
  EVENT_SEASON_READINESS: Workflow;
  TEAM_SEASON_READINESS: Workflow;
  SEASON_STATUS_RESOLVER: Workflow;
}

const validYear = (year: unknown): year is number =>
  Number.isInteger(year) && Number(year) >= 1992 && Number(year) <= 2200;
const validTeam = (key: unknown): key is string => typeof key === "string" && /^frc[0-9]+$/.test(key);
const validEvent = (key: unknown): key is string => typeof key === "string" && /^[a-zA-Z0-9_-]+$/.test(key);


async function readJson<T>(env: SeasonEnvironment, key: string): Promise<T | null> {
  const object = await createDiscoveryServiceClient(env).get<T>(key);
  return object;
}

async function registeredKeys(env: SeasonEnvironment, kind: RefreshKind): Promise<Set<string>> {
  const prefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await createDiscoveryServiceClient(env).list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) keys.add(key.slice(prefix.length).replace(/\.json$/, ""));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function ensureRegistered(
  env: SeasonEnvironment,
  kind: RefreshKind,
  keys: string[],
  year: number,
  step: WorkflowStep,
): Promise<void> {
  const namespace = kind === "event" ? env.EVENT_RUNTIME : env.TEAM_RUNTIME;
  if (!namespace) throw new Error(kind + " runtime namespace is unavailable");
  const prefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
  const existing = await step.do(kind + "-read-runtime-registration-markers", () => registeredKeys(env, kind));
  const missing = [...new Set(keys)].filter((key) => !existing.has(key));
  for (let offset = 0; offset < missing.length; offset += 10) {
    const chunk = missing.slice(offset, offset + 10);
    await step.do(kind + "-register-runtime-chunk-" + offset, async () => {
      for (const key of chunk) {
        const stub = namespace.get(namespace.idFromName(key));
        const identityHeader = kind === "event" ? "X-FieldView-Event-Key" : "X-FieldView-Team-Key";
        const response = await stub.fetch(new Request("https://" + kind + "-runtime/register", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN,
            [identityHeader]: key,
          },
        }));
        if (!response.ok) throw new Error(kind + " runtime registration failed for " + key + " (HTTP " + response.status + ")");
        await createDiscoveryServiceClient(env).put(prefix + key + ".json", JSON.stringify({ year, registered_at: Date.now() }));
      }
      return { registered: chunk.length };
    });
  }
}

async function runSeasonReadiness(
  env: SeasonEnvironment,
  event: WorkflowEvent<SeasonWorkflowInput>,
  step: WorkflowStep,
  kind: RefreshKind,
): Promise<Record<string, unknown>> {
  const year = event.payload?.year;
  if (!validYear(year)) throw new Error("Season readiness requires a four-digit year between 1992 and 2200");
  const store = createDiscoveryServiceClient(env);
  const workflowId = event.instanceId;
  const type = kind + "-readiness";
  const prefix = "admin/workflow-runs/" + type + "/" + workflowId;
  const startedAt = event.payload?.requestedAt ?? Date.now();
  const initial = {
    workflow_id: workflowId, workflow_type: type, status: "running", year,
    started_at: startedAt, updated_at: Date.now(), completed_at: null,
    total: 0, result_chunks: 0, summary: null, error: null,
  };
  await step.do("persist-season-readiness-start", async () => {
    await store.put(prefix + "/record.json", JSON.stringify(initial));
    await store.put("admin/workflow-runs/index/" + type + "/" + String(startedAt).padStart(16, "0") + "-" + workflowId + ".json",
      JSON.stringify({ workflow_id: workflowId, workflow_type: type, year, started_at: startedAt, status: "running" }));
    return { workflow_id: workflowId, year };
  });

  let keys: string[];
  if (kind === "event") {
    const directory = await readJson<{ year: number; events: Array<{ key: string }> }>(env, "discovery/events/" + year + ".json");
    if (!directory || directory.year !== year || !Array.isArray(directory.events)) {
      throw new Error("Event discovery for " + year + " is missing; run season discovery first");
    }
    const discoveredKeys = [...new Set(directory.events.map((item) => item?.key).filter(validEvent))].sort();
    if (Array.isArray(event.payload?.eventKeys)) {
      const requestedKeys = [...new Set(event.payload.eventKeys.filter(validEvent))];
      const discovered = new Set(discoveredKeys);
      if (!requestedKeys.length || requestedKeys.length !== event.payload.eventKeys.length ||
          requestedKeys.some((key) => !discovered.has(key))) {
        throw new Error("Event baseline child contains invalid or undiscovered event keys");
      }
      keys = requestedKeys;
    } else {
      keys = discoveredKeys;
    }
  } else {
    const manifest = await readJson<{ year: number; complete?: boolean; teamCount?: number }>(env, "discovery/teams/" + year + ".json");
    const directory = await readJson<string[]>(env, "registry/teams/" + year + ".json");
    if (!manifest || manifest.year !== year || manifest.complete !== true || !Array.isArray(directory)) {
      throw new Error("Complete team discovery for " + year + " is missing; run season discovery first");
    }
    keys = [...new Set(directory.filter(validTeam))].sort();
  }
  if (!keys.length) throw new Error("No " + kind + " identities were discovered for " + year);

  await ensureRegistered(env, kind, keys, year, step);
  const registry = await registeredKeys(env, kind);
  const registered = keys.filter((key) => registry.has(key));
  if (registered.length !== keys.length) throw new Error("Not all discovered " + kind + " runtimes were registered");

  // The season-level event workflow is an orchestrator only. Each event gets
  // its own Workflow invocation so Cloudflare's per-invocation subrequest
  // budget is not consumed by a season-wide loop of Durable Object calls.
  if (kind === "event" && !Array.isArray(event.payload?.eventKeys)) {
    const chunkSize = 20;
    let dispatched = 0;
    for (let offset = 0; offset < keys.length; offset += chunkSize) {
      const chunk = keys.slice(offset, offset + chunkSize);
      const childId = workflowId + "-batch-" + String(offset / chunkSize).padStart(3, "0");
      await step.do("dispatch-event-baseline-child-" + offset, async () => {
        try {
          await env.EVENT_SEASON_READINESS.create({
            id: childId,
            params: { year, requestedAt: startedAt, eventKeys: chunk },
          });
        } catch (error) {
          const existing = await env.EVENT_SEASON_READINESS.get(childId).catch(() => null);
          if (!existing) throw error;
          const status = await existing.status();
          if (status.status === "errored" || status.status === "terminated") {
            throw new Error("Event baseline child " + status.status + ": " + childId);
          }
        }
        return { dispatched: chunk.length, offset, child_id: childId };
      });
      // Keep batches serial: this bounds both per-invocation subrequests and
      // aggregate TBA request pressure. Never launch the entire season at once.
      let childStatus = "queued";
      for (let attempt = 0; attempt < 360; attempt += 1) {
        const child = await env.EVENT_SEASON_READINESS.get(childId);
        const status = await child.status();
        childStatus = status.status;
        if (childStatus === "complete") break;
        if (childStatus === "errored" || childStatus === "terminated") {
          throw new Error("Event baseline child " + childStatus + ": " + childId);
        }
        await step.sleep("wait-event-baseline-child-" + offset + "-" + attempt, "10 seconds");
      }
      if (childStatus !== "complete") throw new Error("Timed out waiting for event baseline child " + childId);
      dispatched += chunk.length;
    }
    const summary = {
      year, kind, entities_total: keys.length, entities_registered: registered.length,
      children_dispatched: dispatched, batches: Math.ceil(keys.length / chunkSize),
    };
    const completed = {
      ...initial, status: "completed", updated_at: Date.now(), completed_at: Date.now(),
      total: keys.length, result_chunks: 0, summary, error: null,
    };
    await step.do("persist-event-baseline-dispatch-results", async () => {
      await store.put(prefix + "/summary.json", JSON.stringify(summary));
      await store.put(prefix + "/record.json", JSON.stringify(completed));
      await store.put("admin/workflow-runs/index/" + type + "/" + String(startedAt).padStart(16, "0") + "-" + workflowId + ".json",
        JSON.stringify({ workflow_id: workflowId, workflow_type: type, year, started_at: startedAt, completed_at: completed.completed_at, status: "completed" }));
      return completed;
    });
    return summary;
  }

  const results: Array<{
    key: string; state_valid: boolean;
    bootstrapped: boolean; already_initialized?: boolean; resource_status?: string; error?: string;
  }> = [];
  // Each entity gets its own Workflow step. Baseline bootstrap performs at
  // most two TBA requests for events, or two TBA requests plus optional
  // FRC-Colors for teams. Keep entities isolated so retries remain idempotent.
  // Persist each outcome immediately so a later failure never loses completed work.
  for (const key of registered) {
    const outcome = await step.do("bootstrap-" + kind + "-" + key, async () => {
      let result: {
        key: string; state_valid: boolean;
        bootstrapped: boolean; already_initialized?: boolean; resource_status?: string; error?: string;
      };
      try {
        const readiness = await dispatchRuntime(env, kind, key, "readiness", {}, year);
        if (!readiness.ok) throw new Error("Readiness inspection returned HTTP " + readiness.status);
        const readinessResult = await readiness.json() as { state_valid?: boolean };
        if (readinessResult.state_valid === true) {
          result = {
            key, state_valid: true,
            bootstrapped: false, already_initialized: true, resource_status: "existing",
          };
        } else {
          const bootstrapId = "season:" + workflowId + ":" + kind + ":" + year + ":" + key;
          const bundle = await acquireRuntimeBootstrap(env, kind, key, year, bootstrapId);
          const response = await dispatchRuntime(env, kind, key, "bootstrap", bundle as unknown as Record<string, unknown>, year);
          if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error("Bootstrap handoff returned HTTP " + response.status + (detail ? ": " + detail.slice(0, 180) : ""));
          }
          const receipt = await response.json() as { resource_status?: string; accepted?: boolean };
          if (receipt.accepted !== true) throw new Error("Runtime did not confirm bootstrap acceptance");
          const resourceStatus = receipt.resource_status ?? "unknown";
          const verified = await dispatchRuntime(env, kind, key, "readiness", {}, year);
          if (!verified.ok) throw new Error("Post-bootstrap readiness returned HTTP " + verified.status);
          const verifiedBody = await verified.json() as { state_valid?: unknown };
          result = {
            key, state_valid: verifiedBody.state_valid === true,
            bootstrapped: true, already_initialized: false, resource_status: resourceStatus,
          };
        }
      } catch (error) {
        result = {
          key, state_valid: false, bootstrapped: false, already_initialized: false,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        };
      }
      await store.put(prefix + "/progress/" + key + ".json", JSON.stringify(result));
      return result;
    });
    results.push(outcome);
  }

  const summary = {
    year, kind, entities_total: keys.length, entities_registered: registered.length,
    states_valid: results.filter((item) => item.state_valid).length,
    bootstrapped: results.filter((item) => item.bootstrapped).length,
    already_initialized: results.filter((item) => item.already_initialized).length,
    bootstrap_failed: results.filter((item) => !item.state_valid).length,
    partial_resource_sets: results.filter((item) => item.resource_status === "partial").length,
    failed_resource_sets: results.filter((item) => item.resource_status === "failed").length,
    readiness_errors: results.filter((item) => item.error).length,
  };
  const resultChunks = Math.ceil(results.length / 100);
  const completed = {
    ...initial, status: summary.readiness_errors || summary.failed_resource_sets ||
      summary.states_valid !== summary.entities_total ? "completed_with_errors" : "completed",
    updated_at: Date.now(), completed_at: Date.now(), total: results.length,
    result_chunks: resultChunks, summary, error: null,
  };
  await step.do("persist-season-readiness-results", async () => {
    for (let offset = 0; offset < results.length; offset += 100) {
      await store.put(prefix + "/results/" + String(Math.floor(offset / 100)).padStart(4, "0") + ".json",
        JSON.stringify({ offset, results: results.slice(offset, offset + 100) }));
    }
    await store.put(prefix + "/summary.json", JSON.stringify(summary));
    await store.put(prefix + "/record.json", JSON.stringify(completed));
    await store.put("admin/workflow-runs/index/" + type + "/" + String(startedAt).padStart(16, "0") + "-" + workflowId + ".json",
      JSON.stringify({ workflow_id: workflowId, workflow_type: type, year, started_at: startedAt, completed_at: completed.completed_at, status: completed.status }));
    return completed;
  });
  return summary;
}

export class EventSeasonReadinessWorkflow extends WorkflowEntrypoint<SeasonEnvironment, SeasonWorkflowInput> {
  async run(event: WorkflowEvent<SeasonWorkflowInput>, step: WorkflowStep): Promise<Record<string, unknown>> {
    return runSeasonReadiness(this.env, event, step, "event");
  }
}
export class TeamSeasonReadinessWorkflow extends WorkflowEntrypoint<SeasonEnvironment, SeasonWorkflowInput> {
  async run(event: WorkflowEvent<SeasonWorkflowInput>, step: WorkflowStep): Promise<Record<string, unknown>> {
    return runSeasonReadiness(this.env, event, step, "team");
  }
}

export class SeasonStatusResolverWorkflow extends WorkflowEntrypoint<SeasonEnvironment, ResolverInput> {
  async run(event: WorkflowEvent<ResolverInput>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const resolved = await step.do("resolve-tba-canonical-season", async () => {
      const response = await createDiscoveryServiceClient(this.env).catalog("resolve-current-season");
      if (!response.ok) throw new Error("TBA status resolution returned HTTP " + response.status);
      const value = await response.json() as { year?: unknown; maxTeamPage?: unknown; checkedAt?: unknown; fallback?: boolean };
      if (!validYear(value.year)) throw new Error("TBA status resolver returned an invalid canonical season");
      return { year: value.year, maxTeamPage: value.maxTeamPage ?? null, checkedAt: value.checkedAt ?? Date.now(), fallback: value.fallback === true };
    });
    if (!this.env.KV_BINDING) throw new Error("Canonical season KV binding is unavailable");
    const record = { ...resolved, source: resolved.fallback ? "last-known-good" : "tba-status", resolved_at: Date.now() };
    await step.do("persist-canonical-season-kv", async () => {
      await this.env.KV_BINDING!.put("system/canonical-season.json", JSON.stringify(record));
      return record;
    });
    return record;
  }
}
