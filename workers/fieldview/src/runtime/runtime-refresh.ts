import type { RuntimeEnvironment } from "./cloudflare.ts";
import { dispatchRuntime, type RuntimeKind } from "./runtime-dispatch.ts";

export interface RuntimeRefreshTarget {
  kind: RuntimeKind;
  key: string;
  year?: number;
  /** Optional scope-owned resources to refresh; omitted means the runtime's full owned set. */
  endpoints?: string[];
}

export interface RuntimeRefreshOutcome extends RuntimeRefreshTarget {
  ok: boolean;
  status: number | null;
  error?: string;
  response?: unknown;
}


async function startTeamAnalyticsWorkflows(
  env: RuntimeEnvironment,
  outcomes: RuntimeRefreshOutcome[],
): Promise<void> {
  const binding = env.EVENT_ANALYTICS_WORKFLOW;
  if (!binding) return;
  const grouped = new Map<string, string[]>();
  for (const outcome of outcomes) {
    if (!outcome.ok || outcome.kind !== "team" || !outcome.response ||
        typeof outcome.response !== "object" || Array.isArray(outcome.response)) continue;
    const body = outcome.response as Record<string, unknown>;
    if (typeof body.team_state_revision !== "number" ||
        !Number.isSafeInteger(body.team_state_revision) || !Array.isArray(body.affected_events)) continue;
    for (const affected of body.affected_events) {
      if (!affected || typeof affected !== "object" || Array.isArray(affected)) continue;
      const item = affected as Record<string, unknown>;
      if (typeof item.event_key !== "string" || !/^[0-9]{4}[a-zA-Z0-9_-]+$/.test(item.event_key) ||
          typeof item.team_event_revision !== "number" || !Number.isSafeInteger(item.team_event_revision)) continue;
      const revisions = grouped.get(item.event_key) ?? [];
      revisions.push(outcome.key + ":" + body.team_state_revision + ":" + item.team_event_revision);
      grouped.set(item.event_key, revisions);
    }
  }

  for (const [eventKey, revisions] of grouped) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(revisions.sort().join("|")));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
    const baseId = "team-event-analytics-" + eventKey + "-" + hash;
    let workflowId = baseId;
    try {
      const existing = await binding.get(baseId).then((instance) => instance.status());
      if (["queued", "running", "waiting", "waitingForPause", "paused", "complete"].includes(existing.status)) continue;
      workflowId += "-retry-" + Date.now();
    } catch {
      // No Workflow instance exists for this team/event revision set.
    }
    try {
      await binding.create({
        id: workflowId,
        params: { event_key: eventKey, affected_team_keys: null, requested_at: Date.now() },
      });
    } catch (error) {
      try {
        const existing = await binding.get(baseId).then((instance) => instance.status());
        if (["queued", "running", "waiting", "waitingForPause", "paused", "complete"].includes(existing.status)) continue;
      } catch {
        // Preserve the original creation failure.
      }
      throw error;
    }
  }
}

/**
 * Dispatch one explicit refresh command. The target runtime performs all
 * provider acquisition, conditional requests, reconciliation, persistence,
 * and publication for its own scope.
 */
export async function dispatchRuntimeRefresh(
  env: RuntimeEnvironment,
  target: RuntimeRefreshTarget,
  options: { orchestrateAnalytics?: boolean } = {},
): Promise<RuntimeRefreshOutcome> {
  const response = await dispatchRuntime(
    env,
    target.kind,
    target.key,
    "refresh",
    target.endpoints ? { endpoints: target.endpoints } : {},
    target.year,
  );
  const raw = await response.text();
  let body: unknown = undefined;
  if (raw) {
    try { body = JSON.parse(raw); }
    catch { body = raw.slice(0, 500); }
  }
  const outcome: RuntimeRefreshOutcome = {
    ...target,
    ok: response.ok,
    status: response.status,
    ...(!response.ok ? { error: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    ...(body === undefined ? {} : { response: body }),
  };
  if (target.kind === "team" && options.orchestrateAnalytics !== false) {
    await startTeamAnalyticsWorkflows(env, [outcome]);
  }
  return outcome;
}

/**
 * Dispatch a set of runtime refresh commands with bounded concurrency.
 * This is direct RPC fan-out, not a durable queue or a provider-data batch.
 */
export async function dispatchRuntimeRefreshBatch(
  env: RuntimeEnvironment,
  targets: RuntimeRefreshTarget[],
  concurrency = 4,
): Promise<RuntimeRefreshOutcome[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) {
    throw new Error("Runtime refresh concurrency must be an integer between 1 and 6");
  }
  const outcomes = new Array<RuntimeRefreshOutcome>(targets.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      const index = cursor++;
      if (index >= targets.length) return;
      const target = targets[index];
      try {
        outcomes[index] = await dispatchRuntimeRefresh(env, target, { orchestrateAnalytics: false });
      } catch (error) {
        outcomes[index] = {
          ...target,
          ok: false,
          status: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => run()));
  await startTeamAnalyticsWorkflows(env, outcomes);
  return outcomes;
}
