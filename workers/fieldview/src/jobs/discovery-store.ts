import type { DurableObjectNamespaceLike } from "../runtime/cloudflare.ts";

export interface DiscoveryRecord { json<T>(): Promise<T>; text(): Promise<string>; }
export interface DiscoveryStoreClient {
  get(key: string): Promise<DiscoveryRecord | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
  catalog(action: string, input?: Record<string, unknown>): Promise<Response>;
}

/** Direct namespace client; DiscoveryStore is bound to the same Worker as its callers. */
export function createDiscoveryStoreClient(
  namespace: DurableObjectNamespaceLike | undefined,
): DiscoveryStoreClient {
  if (!namespace) throw new Error("DiscoveryStore namespace is unavailable");
  const stub = namespace.get(namespace.idFromName("shared"));
  const send = async (path: string, init?: RequestInit) => {
    const response = await stub.fetch(new Request("https://discovery-store/" + path, init));
    if (!response.ok) throw new Error("Discovery storage returned HTTP " + response.status + ": " + await response.text());
    return response;
  };
  return {
    async get(key) {
      const response = await stub.fetch(new Request("https://discovery-store/get?key=" + encodeURIComponent(key)));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Discovery read returned HTTP " + response.status + ": " + await response.text());
      const value = await response.text();
      return { async text() { return value; }, async json<T>() { return JSON.parse(value) as T; } };
    },
    async put(key, value) {
      await send("put", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
    },
    async list(options = {}) {
      const query = new URLSearchParams({ prefix: options.prefix ?? "", limit: String(options.limit ?? 1000) });
      if (options.cursor) query.set("cursor", options.cursor);
      return await (await send("list?" + query)).json() as {
        objects: Array<{ key: string }>; truncated: boolean; cursor?: string;
      };
    },
    async catalog(action, input = {}) {
      return stub.fetch(new Request("https://discovery-store/catalog/" + action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }));
    },
  };
}
