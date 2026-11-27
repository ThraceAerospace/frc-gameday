import type { DurableObjectStateLike, RuntimeEnvironment } from "./cloudflare.ts";

/**
 * Cloudflare's DurableObject base enables the platform RPC surface used by
 * Wrangler's local Durable Object Explorer. The Node test suite imports these
 * classes directly, so provide a no-op base only outside the Workers runtime.
 */
type DurableObjectBaseConstructor = new (
  ctx: DurableObjectStateLike,
  env: RuntimeEnvironment,
) => object;

class NodeTestDurableObjectBase {
  constructor(_ctx: DurableObjectStateLike, _env: RuntimeEnvironment) {}
}

const isNodeRuntime = Boolean(
  (globalThis as typeof globalThis & { process?: { versions?: { node?: string } } })
    .process?.versions?.node,
);

export const DurableObjectBase: DurableObjectBaseConstructor = await import("cloudflare:workers")
  .then((workers) => (workers as unknown as { DurableObject: DurableObjectBaseConstructor }).DurableObject)
  .catch((error: unknown) => {
    if (isNodeRuntime) return NodeTestDurableObjectBase;
    throw error;
  });
