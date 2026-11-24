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

/**
 * Dispatch one explicit refresh command. The target runtime performs all
 * provider acquisition, conditional requests, reconciliation, persistence,
 * and publication for its own scope.
 */
export async function dispatchRuntimeRefresh(
  env: RuntimeEnvironment,
  target: RuntimeRefreshTarget,
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
  return {
    ...target,
    ok: response.ok,
    status: response.status,
    ...(!response.ok ? { error: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    ...(body === undefined ? {} : { response: body }),
  };
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
        outcomes[index] = await dispatchRuntimeRefresh(env, target);
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
  return outcomes;
}
