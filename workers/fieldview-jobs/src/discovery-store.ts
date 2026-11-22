export interface DiscoveryRecord { json<T>(): Promise<T>; text(): Promise<string>; }
export interface DiscoveryStoreClient {
  get(key: string): Promise<DiscoveryRecord | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
}
interface FetcherLike { fetch(request: Request): Promise<Response>; }

/** service-binding client backed by the Runtime Worker's private DiscoveryStore DO. */
export function createDiscoveryStoreClient(runtime: FetcherLike, token: string): DiscoveryStoreClient {
  const send = async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", "Bearer " + token);
    const response = await runtime.fetch(new Request("https://fieldview-runtime/internal/discovery/" + path, { ...init, headers }));
    if (!response.ok) throw new Error("Discovery storage returned HTTP " + response.status + ": " + await response.text());
    return response;
  };
  return {
    async get(key) {
      const response = await runtime.fetch(new Request("https://fieldview-runtime/internal/discovery/get?key=" + encodeURIComponent(key), {
        headers: { Authorization: "Bearer " + token },
      }));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Discovery read returned HTTP " + response.status + ": " + await response.text());
      const value = await response.text();
      return { async text() { return value; }, async json<T>() { return JSON.parse(value) as T; } };
    },
    async put(key, value) {
      await send("put", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }) });
    },
    async list(options = {}) {
      const query = new URLSearchParams({ prefix: options.prefix ?? "", limit: String(options.limit ?? 1000) });
      if (options.cursor) query.set("cursor", options.cursor);
      return await (await send("list?" + query)).json() as { objects: Array<{ key: string }>; truncated: boolean; cursor?: string };
    },
  };
}
