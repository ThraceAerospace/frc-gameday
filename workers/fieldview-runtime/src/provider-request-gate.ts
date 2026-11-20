import type { RuntimeEnvironment } from "./cloudflare.ts";

export type ProviderRequestPermit =
  | { granted: true; leaseId: string | null }
  | { granted: false; retryAt: number };

/**
 * Serializes provider I/O across EventRuntime and TeamRuntime instances.
 * Test environments without the scheduler binding retain their isolated
 * behavior; deployed runtime bindings always route through the shared gate.
 */
export async function acquireProviderRequestPermit(
  env: RuntimeEnvironment,
  owner: string,
  endpoint: string,
): Promise<ProviderRequestPermit> {
  if (!env.EVENT_SCHEDULER || !env.RUNTIME_ADMIN_TOKEN) return { granted: true, leaseId: null };
  const scheduler = env.EVENT_SCHEDULER.get(env.EVENT_SCHEDULER.idFromName("global"));
  const response = await scheduler.fetch(new Request("https://event-scheduler/provider-request/acquire", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ owner, endpoint }),
  }));
  if (!response.ok) throw new Error("Shared provider request gate returned HTTP " + response.status);
  const body = await response.json() as { granted?: boolean; lease_id?: string; retry_at?: number };
  if (body.granted === true) {
    if (typeof body.lease_id !== "string" || body.lease_id.length === 0) {
      throw new Error("Shared provider request gate granted a permit without a releasable lease id");
    }
    return { granted: true, leaseId: body.lease_id };
  }
  return { granted: false, retryAt: Number.isFinite(body.retry_at) ? Number(body.retry_at) : Date.now() + 1_000 };
}

export async function releaseProviderRequestPermit(
  env: RuntimeEnvironment,
  leaseId: string | null,
): Promise<void> {
  if (!leaseId || !env.EVENT_SCHEDULER || !env.RUNTIME_ADMIN_TOKEN) return;
  const scheduler = env.EVENT_SCHEDULER.get(env.EVENT_SCHEDULER.idFromName("global"));
  // Release is best-effort: if the Worker is interrupted or the scheduler is
  // temporarily unavailable, the durable lease expires automatically.
  await scheduler.fetch(new Request("https://event-scheduler/provider-request/release", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ lease_id: leaseId }),
  })).catch(() => undefined);
}
