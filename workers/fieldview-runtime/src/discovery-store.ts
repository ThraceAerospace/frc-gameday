import type { DurableObjectStateLike, RuntimeEnvironment } from "./cloudflare.ts";
const PREFIX = "discovery-object:";
const MAX_LIST_LIMIT = 1000;

/** Shared low-volume catalog; event/team canonical state remains entity-owned. */
export class DiscoveryStore {
  private readonly storage: DurableObjectStateLike["storage"];
  constructor(state: DurableObjectStateLike, _env?: RuntimeEnvironment) { this.storage = state.storage; }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/get") {
      const key = url.searchParams.get("key");
      if (!key || key.length > 1024) return Response.json({ error: "Invalid key" }, { status: 400 });
      const value = await this.storage.get<string>(PREFIX + key);
      return value === undefined ? new Response(null, { status: 404 }) : new Response(value, {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (request.method === "POST" && url.pathname === "/put") {
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Invalid write" }, { status: 400 });
      const input = body as Record<string, unknown>;
      if (typeof input.key !== "string" || !input.key.length || input.key.length > 1024 || typeof input.value !== "string") {
        return Response.json({ error: "Expected a key and string value" }, { status: 400 });
      }
      if (input.value.length > 4_000_000) return Response.json({ error: "Catalog record exceeds 4 MB" }, { status: 413 });
      await this.storage.put(PREFIX + input.key, input.value);
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/list") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const cursor = url.searchParams.get("cursor") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? "1000");
      if (prefix.length > 1024 || cursor.length > 1100 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        return Response.json({ error: "Invalid list query" }, { status: 400 });
      }
      const entries = await this.storage.list<string>({
        prefix: PREFIX + prefix, ...(cursor ? { startAfter: PREFIX + cursor } : {}), limit: limit + 1,
      });
      const keys = [...entries.keys()].map((key) => key.slice(PREFIX.length)).filter((key) => key.startsWith(prefix));
      const truncated = keys.length > limit;
      const page = keys.slice(0, limit);
      return Response.json({ objects: page.map((key) => ({ key })), truncated,
        ...(truncated && page.length ? { cursor: page[page.length - 1] } : {}) });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
