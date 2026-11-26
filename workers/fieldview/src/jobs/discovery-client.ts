import type { RuntimeEnvironment } from "../runtime/cloudflare.ts";
import { DiscoveryService } from "../runtime/discovery-service.ts";

export interface DiscoveryRecord { json<T>(): Promise<T>; text(): Promise<string>; }
export interface DiscoveryServiceClient {
  get(key: string): Promise<DiscoveryRecord | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
  catalog(action: string, input?: Record<string, unknown>): Promise<Response>;
}

/** In-process D1 client; discovery logic runs in the Worker, not a Durable Object. */
export function createDiscoveryServiceClient(env: RuntimeEnvironment): DiscoveryServiceClient {
  const storage = env.DISCOVERY_STORAGE ?? env.DB;
  if (!storage) throw new Error("D1 database binding is unavailable");
  const service = new DiscoveryService(storage, env);
  const send = async (path: string, init?: RequestInit) => {
    const response = await service.fetch(new Request("https://discovery-service/" + path, init));
    if (!response.ok) throw new Error("Discovery storage returned HTTP " + response.status + ": " + await response.text());
    return response;
  };
  return {
    async get(key) {
      const response = await service.fetch(new Request("https://discovery-service/get?key=" + encodeURIComponent(key)));
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
      return service.fetch(new Request("https://discovery-service/catalog/" + action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }));
    },
  };
}
