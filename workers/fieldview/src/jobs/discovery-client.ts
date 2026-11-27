import type { RuntimeEnvironment } from "../runtime/cloudflare.ts";
import { DiscoveryService } from "../runtime/discovery-service.ts";

export interface DiscoveryServiceClient {
  get<T = unknown>(key: string): Promise<T | null>;
  put(key: string, value: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ keys: string[]; truncated: boolean; cursor?: string }>;
  catalog(action: string, input?: Record<string, unknown>): Promise<Response>;
}

/** Direct in-process access to the D1 discovery and system record repositories. */
export function createDiscoveryServiceClient(env: RuntimeEnvironment): DiscoveryServiceClient {
  const storage = env.DISCOVERY_STORAGE ?? env.DB;
  if (!storage) throw new Error("D1 database binding is unavailable");
  const service = new DiscoveryService(storage, env);
  return {
    async get<T>(key: string): Promise<T | null> {
      const value = await service.getRecord(key);
      return value === undefined ? null : JSON.parse(value) as T;
    },
    async put(key: string, value: string): Promise<void> {
      await service.putRecord(key, value);
    },
    async list(options = {}) {
      const prefix = options.prefix ?? "";
      const entries = await service.listRecords({
        prefix,
        ...(options.cursor ? { startAfter: options.cursor } : {}),
        limit: options.limit ?? 1000,
      });
      const keys = [...entries.keys()];
      const limit = options.limit ?? 1000;
      const truncated = keys.length > limit;
      const page = keys.slice(0, limit);
      return { keys: page, truncated, ...(truncated && page.length ? { cursor: page[page.length - 1] } : {}) };
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
