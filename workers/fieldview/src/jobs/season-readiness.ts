import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { RuntimeEnvironment } from "../runtime/cloudflare.ts";
import { dispatchRuntime } from "../runtime/runtime-dispatch.ts";
import { createDiscoveryServiceClient } from "./discovery-client.ts";

type RefreshKind = "event" | "team";
type RefreshTask = { kind: RefreshKind; key: string; year: number };
export type RefreshMessage = { version: 1; tasks: RefreshTask[] };
type SeasonWorkflowInput = { year: number; requestedAt?: number };
type ResolverInput = { requestedAt?: number };

interface QueueProducerLike {
  sendBatch(messages: Array<{ body: RefreshMessage }>): Promise<void>;
}
export interface SeasonEnvironment extends RuntimeEnvironment {
  SEASON_REFRESH_QUEUE?: QueueProducerLike;
  EVENT_SEASON_READINESS: Workflow;
  TEAM_SEASON_READINESS: Workflow;
  SEASON_STATUS_RESOLVER: Workflow;
}
interface QueueMessageLike {
  body: RefreshMessage;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}
interface QueueBatchLike { messages: QueueMessageLike[]; }

const validYear = (year: unknown): year is number =>
  Number.isInteger(year) && Number(year) >= 1992 && Number(year) <= 2200;
const validTeam = (key: unknown): key is string => typeof key === "string" && /^frc[0-9]+$/.test(key);
const validEvent = (key: unknown): key is string => typeof key === "string" && /^[a-zA-Z0-9_-]+$/.test(key);

async function readJson<T>(env: SeasonEnvironment, key: string): Promise<T | null> {
  const object = await createDiscoveryServiceClient(env).get(key);
  return object ? object.json<T>() : null;
}

async function registeredKeys(env: SeasonEnvironment, kind: RefreshKind): Promise<Set<string>> {
  const prefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await createDiscoveryServiceClient(env).list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.objects) keys.add(item.key.slice(prefix.length).replace(/\.json$/, ""));
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
  for (let offset = 0; offset < missing.length; offset += 25) {
    const chunk = missing.slice(offset, offset + 25);
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
        await createDiscoveryServiceClient(env).put(prefix + key + ".json", JSON.stringify({ year, registered_at: Date.now() }), {
          httpMetadata: { contentType: "application/json" },
        });
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
  if (!env.SEASON_REFRESH_QUEUE) throw new Error("Season refresh Queue binding is unavailable");
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
    await store.put(prefix + "/record.json", JSON.stringify(initial), { httpMetadata: { contentType: "application/json" } });
    await store.put("admin/workflow-runs/index/" + type + "/" + String(startedAt).padStart(16, "0") + "-" + workflowId + ".json",
      JSON.stringify({ workflow_id: workflowId, workflow_type: type, year, started_at: startedAt, status: "running" }),
      { httpMetadata: { contentType: "application/json" } });
    return { workflow_id: workflowId, year };
  });

  let keys: string[];
  if (kind === "event") {
    const directory = await readJson<{ year: number; events: Array<{ key: string }> }>(env, "discovery/events/" + year + ".json");
    if (!directory || directory.year !== year || !Array.isArray(directory.events)) {
      throw new Error("Event discovery for " + year + " is missing; run season discovery first");
    }
    keys = [...new Set(directory.events.map((item) => item?.key).filter(validEvent))].sort();
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
  const needsRefresh: RefreshTask[] = [];
  const results: Array<{ key: string; state_valid: boolean; refresh_required: boolean; queued: boolean; error?: string }> = [];

  // Readiness calls are deliberately bounded. Refresh work is queued in grouped
  // messages so one queue message can represent many entity dispatches.
  for (let offset = 0; offset < registered.length; offset += 25) {
    const chunk = registered.slice(offset, offset + 25);
    const outcomes = await step.do("inspect-" + kind + "-readiness-" + offset, async () =>
      Promise.all(chunk.map(async (key) => {
        try {
          const response = await dispatchRuntime(env, kind, key, "readiness", {}, year);
          if (!response.ok) throw new Error("Readiness returned HTTP " + response.status);
          const value = await response.json() as { state_valid?: boolean; refresh_required?: boolean };
          const stateValid = value.state_valid === true;
          const refreshRequired = value.refresh_required === true || !stateValid;
          return { key, state_valid: stateValid, refresh_required: refreshRequired };
        } catch (error) {
          return { key, state_valid: false, refresh_required: false, error: String(error).slice(0, 300) };
        }
      })));
    for (const item of outcomes) {
      if (item.refresh_required) needsRefresh.push({ kind, key: item.key, year });
      results.push({ ...item, queued: false });
    }
  }

  const messages: Array<{ body: RefreshMessage }> = [];
  for (let offset = 0; offset < needsRefresh.length; offset += 25) {
    messages.push({ body: { version: 1, tasks: needsRefresh.slice(offset, offset + 25) } });
  }
  for (let offset = 0; offset < messages.length; offset += 100) {
    const batch = messages.slice(offset, offset + 100);
    await step.do("enqueue-" + kind + "-refresh-batch-" + offset, async () => {
      await env.SEASON_REFRESH_QUEUE!.sendBatch(batch);
      return { messages: batch.length };
    });
  }

  const summary = {
    year, kind, entities_total: keys.length, entities_registered: registered.length,
    states_valid: results.filter((item) => item.state_valid).length,
    refresh_required: needsRefresh.length, queue_messages: messages.length,
    readiness_errors: results.filter((item) => item.error).length,
  };
  const resultChunks = Math.ceil(results.length / 100);
  const completed = {
    ...initial, status: summary.readiness_errors ? "completed_with_errors" : "completed",
    updated_at: Date.now(), completed_at: Date.now(), total: results.length,
    result_chunks: resultChunks, summary, error: null,
  };
  await step.do("persist-season-readiness-results", async () => {
    for (let offset = 0; offset < results.length; offset += 100) {
      await store.put(prefix + "/results/" + String(Math.floor(offset / 100)).padStart(4, "0") + ".json",
        JSON.stringify({ offset, results: results.slice(offset, offset + 100) }),
        { httpMetadata: { contentType: "application/json" } });
    }
    await store.put(prefix + "/summary.json", JSON.stringify(summary), { httpMetadata: { contentType: "application/json" } });
    await store.put(prefix + "/record.json", JSON.stringify(completed), { httpMetadata: { contentType: "application/json" } });
    await store.put("admin/workflow-runs/index/" + type + "/" + String(startedAt).padStart(16, "0") + "-" + workflowId + ".json",
      JSON.stringify({ workflow_id: workflowId, workflow_type: type, year, started_at: startedAt, completed_at: completed.completed_at, status: completed.status }),
      { httpMetadata: { contentType: "application/json" } });
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
    const resolved = await step.do("resolve-tba-canonical-season", { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } }, async () => {
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

export async function consumeSeasonRefreshQueue(batch: QueueBatchLike, env: SeasonEnvironment): Promise<void> {
  for (const message of batch.messages) {
    const payload = message.body;
    if (!payload || payload.version !== 1 || !Array.isArray(payload.tasks) || payload.tasks.length > 25) {
      message.ack();
      continue;
    }
    let retry = false;
    for (const task of payload.tasks) {
      if (!validYear(task.year) || (task.kind !== "event" && task.kind !== "team") ||
          (task.kind === "team" ? !validTeam(task.key) : !validEvent(task.key))) continue;
      try {
        const readiness = await dispatchRuntime(env, task.kind, task.key, "readiness", {}, task.year);
        if (readiness.status === 429 || readiness.status >= 500) { retry = true; break; }
        if (!readiness.ok) continue;
        const status = await readiness.json() as { state_valid?: boolean; refresh_required?: boolean };
        if (status.state_valid === true && status.refresh_required !== true) continue;
        const refresh = await dispatchRuntime(env, task.kind, task.key, "refresh", {}, task.year);
        if (refresh.status === 429 || refresh.status >= 500) { retry = true; break; }
      } catch {
        retry = true;
        break;
      }
    }
    if (retry) message.retry({ delaySeconds: 30 });
    else message.ack();
  }
}
