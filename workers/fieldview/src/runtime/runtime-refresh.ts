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


/** Additional event-owned changes collected during the same polling cycle. */
export interface EventAnalyticsRefreshRequest {
  /** null is conservative: the match set could not be compared safely. */
  affected_team_keys: string[] | null;
  /** Stable source/revision identities for recovery requests; avoids a new Workflow on every poll tick. */
  revision_parts?: string[];
  /** Recovery requests may restart a terminal failed Workflow on a bounded time window. */
  recovery?: boolean;
  /** Ordinary event refreshes retain their per-cycle identity when coalesced with recovery. */
  poll_cycle_token?: number;
}

async function startEventAnalyticsWorkflows(
  env: RuntimeEnvironment,
  outcomes: RuntimeRefreshOutcome[],
  options: {
    additionalAffectedEvents?: Map<string, EventAnalyticsRefreshRequest>;
    requestedAt?: number;
  } = {},
): Promise<void> {
  const binding = env.EVENT_ANALYTICS_WORKFLOW;
  if (!binding) return;
  const grouped = new Map<string, { revisionParts: string[]; teamKeys: Set<string>; fullRecompute: boolean; recovery: boolean }>();
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
      const group = grouped.get(item.event_key) ?? { revisionParts: [], teamKeys: new Set<string>(), fullRecompute: false, recovery: false };
      group.revisionParts.push(outcome.key + ":" + body.team_state_revision + ":" + item.team_event_revision);
      group.teamKeys.add(outcome.key);
      grouped.set(item.event_key, group);
    }
  }

  for (const [eventKey, request] of options.additionalAffectedEvents ?? []) {
    if (!/^[0-9]{4}[a-zA-Z0-9_-]+$/.test(eventKey)) continue;
    const group = grouped.get(eventKey) ?? { revisionParts: [], teamKeys: new Set<string>(), fullRecompute: false, recovery: false };
    if (request.affected_team_keys === null) {
      group.fullRecompute = true;
    } else {
      for (const teamKey of request.affected_team_keys) {
        if (/^frc[0-9]+$/.test(teamKey)) group.teamKeys.add(teamKey);
      }
    }
    if (request.revision_parts?.length) group.revisionParts.push(...request.revision_parts);
    if (request.poll_cycle_token !== undefined || !request.revision_parts?.length) {
      group.revisionParts.push("poll-cycle:" + (request.poll_cycle_token ?? options.requestedAt ?? 0) + ":" +
        (request.affected_team_keys === null ? "full" : [...request.affected_team_keys].sort().join(",")));
    }
    group.recovery ||= request.recovery === true;
    grouped.set(eventKey, group);
  }

  for (const [eventKey, group] of grouped) {
    if (!group.fullRecompute && group.teamKeys.size === 0) continue;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(group.revisionParts.sort().join("|")));
    const affectedTeamKeys = group.fullRecompute ? null : [...group.teamKeys].sort();
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
    const baseId = "team-event-analytics-" + eventKey + "-" + hash;
    let workflowId = baseId;
    const requestedAt = options.requestedAt ?? Date.now();
    const recoveryWindow = Math.floor(requestedAt / (30 * 60_000));
    try {
      const existing = await binding.get(baseId).then((instance) => instance.status());
      if (["queued", "running", "waiting", "waitingForPause", "paused"].includes(existing.status)) continue;
      if (existing.status === "complete" && !group.recovery) continue;
      if (group.recovery && ["complete", "errored", "terminated"].includes(existing.status)) {
        workflowId = baseId + "-recovery-" + recoveryWindow;
      } else if (existing.status !== "complete") {
        workflowId += "-retry-" + Date.now();
      }
    } catch {
      // No Workflow instance exists for this team/event revision set.
    }
    if (group.recovery && workflowId !== baseId) {
      let retryAlreadyExists = false;
      try {
        const status = await binding.get(workflowId).then((instance) => instance.status());
        retryAlreadyExists = ["queued", "running", "waiting", "waitingForPause", "paused", "complete", "errored", "terminated"].includes(status.status);
      } catch {
        // This recovery window has not been used yet.
      }
      if (retryAlreadyExists) continue;
      // The parent may have completed after scheduling one of its own retries.
      const retryRequestedAtValues = [0, 1].map((offset) => recoveryWindow * 30 * 60_000 + offset);
      let childRetryActive = false;
      for (const retryRequestedAt of retryRequestedAtValues) {
        for (const attempt of [1, 2]) {
          try {
            const status = await binding.get("event-analytics-" + eventKey + "-" + retryRequestedAt + "-retry-" + attempt)
              .then((instance) => instance.status());
            if (["queued", "running", "waiting", "waitingForPause", "paused"].includes(status.status)) {
              childRetryActive = true;
              break;
            }
          } catch {
            // No child retry for this attempt.
          }
        }
        if (childRetryActive) break;
      }
      if (childRetryActive) continue;
    }
    try {
      await binding.create({
        id: workflowId,
        params: {
          event_key: eventKey,
          affected_team_keys: affectedTeamKeys,
          requested_at: group.recovery
            ? recoveryWindow * 30 * 60_000 + (workflowId === baseId ? 0 : 1)
            : requestedAt,
        },
      });
    } catch (error) {
      try {
        const existing = await binding.get(workflowId).then((instance) => instance.status());
        if (["queued", "running", "waiting", "waitingForPause", "paused", "complete", "errored", "terminated"].includes(existing.status)) continue;
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
    await startEventAnalyticsWorkflows(env, [outcome]);
  }
  return outcome;
}

/**
 * Dispatch a set of runtime refresh commands with bounded concurrency.
 * Refreshes remain bounded direct RPC; affected cross-runtime analytics are coalesced into a Workflow.
 */
export async function dispatchRuntimeRefreshBatch(
  env: RuntimeEnvironment,
  targets: RuntimeRefreshTarget[],
  concurrency = 4,
  options: { additionalAffectedEvents?: Map<string, EventAnalyticsRefreshRequest>; requestedAt?: number } = {},
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
  await startEventAnalyticsWorkflows(env, outcomes, options);
  return outcomes;
}
