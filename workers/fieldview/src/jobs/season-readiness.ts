import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { RuntimeEnvironment } from "../runtime/cloudflare.ts";
import { dispatchRuntime } from "../runtime/runtime-dispatch.ts";
import { createDiscoveryServiceClient } from "./discovery-client.ts";
import { acquireRuntimeBootstrap } from "./runtime-bootstrap-acquisition.ts";

type RefreshKind = "event" | "team";
type RefreshTask = { kind: RefreshKind; key: string; year: number; workflow_id: string; workflow_type: string };
export type RefreshMessage = { version: 1; tasks: RefreshTask[] };

type QueueSendMessage = { body: RefreshMessage };
type QueueSendBatch = { messages: QueueSendMessage[]; estimated_bytes: number };

// Cloudflare limits sendBatch() to 100 messages and 256,000 bytes total.
// Keep a 16 KB safety margin and account for per-message metadata (~100 bytes).
const MAX_QUEUE_BATCH_MESSAGES = 100;
const MAX_QUEUE_BATCH_BYTES = 240_000;
const QUEUE_MESSAGE_METADATA_BUDGET_BYTES = 128;
const MAX_QUEUE_MESSAGE_BYTES = 127_000;

export function packSeasonRefreshQueueBatches(messages: QueueSendMessage[]): QueueSendBatch[] {
  const encoder = new TextEncoder();
  const batches: QueueSendBatch[] = [];
  let current: QueueSendMessage[] = [];
  let currentBytes = 0;

  const flush = () => {
    if (!current.length) return;
    batches.push({ messages: current, estimated_bytes: currentBytes });
    current = [];
    currentBytes = 0;
  };

  for (const message of messages) {
    const bodyBytes = encoder.encode(JSON.stringify(message.body)).byteLength;
    const messageBytes = bodyBytes + QUEUE_MESSAGE_METADATA_BUDGET_BYTES;
    if (messageBytes > MAX_QUEUE_MESSAGE_BYTES) {
      throw new Error("Season refresh queue message exceeds the safe 127 KB message budget (" + messageBytes + " bytes)");
    }
    if (current.length &&
        (current.length >= MAX_QUEUE_BATCH_MESSAGES || currentBytes + messageBytes > MAX_QUEUE_BATCH_BYTES)) {
      flush();
    }
    current.push(message);
    currentBytes += messageBytes;
  }
  flush();
  return batches;
}
type SeasonWorkflowInput = { year: number; requestedAt?: number };
type ResolverInput = { requestedAt?: number };

interface QueueProducerLike {
  sendBatch(messages: Array<{ body: RefreshMessage }>): Promise<void>;
}
export interface SeasonEnvironment extends RuntimeEnvironment {
  SEASON_REFRESH_QUEUE?: QueueProducerLike;
  SEASON_DISCOVERY: Workflow;
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

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }));
  return results;
}

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
  const results: Array<{
    key: string; state_valid: boolean; refresh_required: boolean; queued: boolean;
    bootstrapped: boolean; publication_status?: string; error?: string;
  }> = [];
  for (let offset = 0; offset < keys.length; offset += 25) {
    const chunk = keys.slice(offset, offset + 25);
    const outcomes = await step.do("bootstrap-" + kind + "-chunk-" + offset, async () =>
      mapWithConcurrency(chunk, 4, async (key) => {
        try {
          const readiness = await dispatchRuntime(env, kind, key, "readiness", {}, year);
          if (!readiness.ok) throw new Error("Readiness inspection returned HTTP " + readiness.status);
          const readinessResult = await readiness.json() as { state_valid?: boolean };
          if (readinessResult.state_valid === true) {
            return {
              key, state_valid: true, refresh_required: false, queued: false,
              bootstrapped: true, already_initialized: true, publication_status: "existing",
            };
          }
          const bootstrapId = "season:" + workflowId + ":" + kind + ":" + year + ":" + key;
          const bundle = await acquireRuntimeBootstrap(env, kind, key, year, bootstrapId);
          const response = await dispatchRuntime(env, kind, key, "bootstrap", bundle as unknown as Record<string, unknown>, year);
          if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error("Bootstrap handoff returned HTTP " + response.status + (detail ? ": " + detail.slice(0, 180) : ""));
          }
          const receipt = await response.json() as { publication_status?: string; accepted?: boolean };
          if (receipt.accepted !== true) throw new Error("Runtime did not confirm bootstrap acceptance");
          const publicationStatus = receipt.publication_status ?? "unknown";
          return {
            key, state_valid: publicationStatus !== "failed", refresh_required: false, queued: false,
            bootstrapped: true, already_initialized: false, publication_status: publicationStatus,
          };
        } catch (error) {
          return {
            key, state_valid: false, refresh_required: false, queued: false, bootstrapped: false, already_initialized: false,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          };
        }
      }));
    results.push(...outcomes);
  }

  const summary = {
    year, kind, entities_total: keys.length, entities_registered: registered.length,
    states_valid: results.filter((item) => item.state_valid).length,
    bootstrapped: results.filter((item) => item.bootstrapped).length,
    already_initialized: results.filter((item) => item.already_initialized).length,
    bootstrap_failed: results.filter((item) => !item.bootstrapped).length,
    partial_publications: results.filter((item) => item.publication_status === "partial").length,
    failed_publications: results.filter((item) => item.publication_status === "failed").length,
    readiness_errors: results.filter((item) => item.error).length,
  };
  const resultChunks = Math.ceil(results.length / 100);
  const completed = {
    ...initial, status: summary.readiness_errors || summary.failed_publications ? "completed_with_errors" : "completed",
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
  // A consumer invocation may contain multiple queue messages. Track stable
  // entity-season task identities across the whole invocation so repeated
  // entity-season work is visible in logs without suppressing readiness checks.
  const seenTaskIds = new Set<string>();

  for (let messageIndex = 0; messageIndex < batch.messages.length; messageIndex += 1) {
    const message = batch.messages[messageIndex]!;
    const payload = message.body;
    if (!payload || payload.version !== 1 || !Array.isArray(payload.tasks) || payload.tasks.length > 25) {
      console.warn("[season-refresh-queue-invalid-message]", JSON.stringify({ message_index: messageIndex }));
      message.ack();
      continue;
    }

    const duplicateTaskIds = new Set<string>();
    const outcomes = await mapWithConcurrency(payload.tasks, 4, async (task) => {
      if (!validYear(task.year) || (task.kind !== "event" && task.kind !== "team") ||
          (task.kind === "team" ? !validTeam(task.key) : !validEvent(task.key))) {
        return { task, task_id: null, outcome: "invalid" as const };
      }
      const taskId = task.kind + ":" + task.year + ":" + task.key;
      const duplicate = seenTaskIds.has(taskId);
      if (duplicate) duplicateTaskIds.add(taskId);
      seenTaskIds.add(taskId);

      try {
        const readiness = await dispatchRuntime(env, task.kind, task.key, "readiness", {}, task.year);
        if (readiness.status === 429 || readiness.status >= 500) {
          return { task, task_id: taskId, duplicate, outcome: "retry" as const, detail: "readiness_http_" + readiness.status };
        }
        if (!readiness.ok) {
          return { task, task_id: taskId, duplicate, outcome: "skipped" as const, detail: "readiness_http_" + readiness.status };
        }
        const status = await readiness.json() as { state_valid?: boolean; refresh_required?: boolean };
        if (status.state_valid === true && status.refresh_required !== true) {
          return { task, task_id: taskId, duplicate, outcome: "skipped" as const, detail: "already_ready" };
        }
        const refresh = await dispatchRuntime(env, task.kind, task.key, "refresh", {}, task.year);
        if (refresh.status === 429 || refresh.status >= 500) {
          return { task, task_id: taskId, duplicate, outcome: "retry" as const, detail: "refresh_http_" + refresh.status };
        }
        return refresh.ok
          ? { task, task_id: taskId, duplicate, outcome: "dispatched" as const }
          : { task, task_id: taskId, duplicate, outcome: "skipped" as const, detail: "refresh_http_" + refresh.status };
      } catch (error) {
        return {
          task,
          task_id: taskId,
          duplicate,
          outcome: "retry" as const,
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 240),
        };
      }
    });

    const count = (outcome: typeof outcomes[number]["outcome"]) =>
      outcomes.filter((item) => item.outcome === outcome).length;
    const workflowIds = [...new Set(payload.tasks.map((task) => task.workflow_id).filter((id): id is string => typeof id === "string"))];
    const years = [...new Set(payload.tasks.map((task) => task.year))];
    const kinds = [...new Set(payload.tasks.map((task) => task.kind))];

    // Per-task structured logs make repeated entity-season dispatches
    // attributable to their originating Workflow without adding storage writes.
    for (const item of outcomes) {
      console.log("[season-refresh-task]", JSON.stringify({
        task_id: item.task_id,
        kind: item.task.kind,
        key: item.task.key,
        year: item.task.year,
        workflow_id: item.task.workflow_id ?? null,
        workflow_type: item.task.workflow_type ?? null,
        duplicate: "duplicate" in item ? item.duplicate : false,
        outcome: item.outcome,
        ...( "detail" in item ? { detail: item.detail } : {}),
      }));
    }

    const retry = count("retry") > 0;
    console.log("[season-refresh-queue]", JSON.stringify({
      message_index: messageIndex,
      workflow_ids: workflowIds,
      years,
      kinds,
      tasks: payload.tasks.length,
      unique_task_ids_in_message: new Set(outcomes.map((item) => item.task_id).filter(Boolean)).size,
      duplicate_tasks: duplicateTaskIds.size,
      dispatched: count("dispatched"),
      skipped: count("skipped"),
      invalid: count("invalid"),
      retry: count("retry"),
      concurrency: Math.min(4, payload.tasks.length),
      outcomes: outcomes.map((item) => ({ task_id: item.task_id, duplicate: "duplicate" in item ? item.duplicate : false, outcome: item.outcome })),
    }));
    if (retry) message.retry({ delaySeconds: 30 });
    else message.ack();
  }
}
