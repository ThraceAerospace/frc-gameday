import type { DurableObjectStateLike, RuntimeEnvironment } from "./cloudflare.ts";
const PREFIX = "discovery-object:";
const MAX_LIST_LIMIT = 1000;

/** Shared low-volume catalog; event/team canonical state remains entity-owned. */
export class DiscoveryStore {
  private readonly storage: DurableObjectStateLike["storage"];
  constructor(state: DurableObjectStateLike, _env?: RuntimeEnvironment) { this.storage = state.storage; }

  private async deleteKey(key: string): Promise<void> {
    await this.storage.delete(PREFIX + key);
  }

  private async deletePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    for (;;) {
      const entries = await this.storage.list<string>({
        prefix: PREFIX + prefix,
        ...(cursor ? { startAfter: cursor } : {}),
        limit: 1000,
      });
      const keys = [...entries.keys()];
      if (!keys.length) return;
      await Promise.all(keys.map((key) => this.storage.delete(key)));
      if (keys.length < 1000) return;
      cursor = keys[keys.length - 1];
    }
  }

  private async pruneSupersededRecord(key: string, previous: string | undefined, next: string): Promise<void> {
    if (!previous) return;
    try {
      const oldValue = JSON.parse(previous) as Record<string, unknown>;
      const newValue = JSON.parse(next) as Record<string, unknown>;
      const teamManifest = key.match(/^discovery\/teams\/(\d{4})\.json$/);
      if (teamManifest && typeof oldValue.generation === "number" && oldValue.generation !== newValue.generation) {
        await this.deletePrefix(`discovery/team-pages/${teamManifest[1]}/${oldValue.generation}/`);
      }
      const eventDirectory = key.match(/^discovery\/events\/(\d{4})\.json$/);
      if (eventDirectory && typeof oldValue.updatedAt === "number" && oldValue.updatedAt !== newValue.updatedAt) {
        await this.deletePrefix(`discovery/event-chunks/${eventDirectory[1]}/${oldValue.updatedAt}/`);
        await this.deleteKey(`discovery/staging/${eventDirectory[1]}/${oldValue.updatedAt}.json`);
        await this.deleteKey(`discovery/staging/${eventDirectory[1]}/${oldValue.updatedAt}-keys.json`);
      }
      if (key === "projections/events/this-week/current.json" &&
          typeof oldValue.runAt === "number" && oldValue.runAt !== newValue.runAt) {
        await this.deletePrefix(`projections/events/this-week/${oldValue.runAt}/`);
      }
      const coverageAudit = key.match(/^admin\/coverage-audits\/(\d{4})\.json$/);
      if (coverageAudit && typeof oldValue.items_prefix === "string" && oldValue.items_prefix !== newValue.items_prefix) {
        await this.deletePrefix(oldValue.items_prefix);
      }
    } catch {
      // A malformed prior record must not prevent publishing its replacement.
    }
  }
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
      if (new TextEncoder().encode(input.value).byteLength > 7_000_000) {
        return Response.json({ error: "Catalog record exceeds the 7 MB safety limit" }, { status: 413 });
      }
      const storageKey = PREFIX + input.key;
      const previous = await this.storage.get<string>(storageKey);
      await this.storage.put(storageKey, input.value);
      await this.pruneSupersededRecord(input.key, previous, input.value);
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
