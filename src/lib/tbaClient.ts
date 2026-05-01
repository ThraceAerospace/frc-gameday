const BASE_URL = "https://www.thebluealliance.com/api/v3";
import { redis } from "@/lib/redis";

function norm(endpoint: string) {
  return endpoint.replace(/\//g, ":");
}

/**
 * Derive cache tags from endpoint structure
 * You can expand this freely later.
 */
function deriveTags(endpoint: string): string[] {
  const parts = endpoint.split("/").filter(Boolean);

  const tags: string[] = [];

  // /event/:key/...
  const eventIdx = parts.indexOf("event");
  if (eventIdx !== -1 && parts[eventIdx + 1]) {
    const eventKey = parts[eventIdx + 1];

    tags.push(`event:${eventKey}`);

    if (parts[eventIdx + 2]) {
      tags.push(`event:${eventKey}:${parts[eventIdx + 2]}`);
    }
  }

  // /team/:key/...
  const teamIdx = parts.indexOf("team");
  if (teamIdx !== -1 && parts[teamIdx + 1]) {
    tags.push(`team:${parts[teamIdx + 1]}`);
  }

  return tags;
}

function cacheKey(endpoint: string) {
  return `cache${norm(endpoint)}`;
}

function etagKey(endpoint: string) {
  return `etag${norm(endpoint)}`;
}

function tagKey(tag: string) {
  return `tag:${tag}`;
}

export class TBAClient {
  constructor(private authKey: string) {}

  /**
   * PUBLIC: invalidate a tag (used by webhooks)
   */
  async invalidateTag(tag: string) {
    const key = tagKey(tag);

    const members = await redis.smembers(key);
    if (!members?.length) return;

    const pipeline = redis.pipeline();

    for (const cache of members) {
      pipeline.del(cache);
      pipeline.del(`etag:${cache.replace("cache:", "")}`);
    }

    pipeline.del(key);

    await pipeline.exec();

    console.log(`[TBA] invalidated tag ${tag}`);
  }

  /**
   * MAIN FETCH METHOD
   */
  async get(
    endpoint: string,
    revalidate = 30,
    options?: { noStore?: boolean; forceRefresh?: boolean }
  ) {
    const cKey = cacheKey(endpoint);
    const eKey = etagKey(endpoint);
    const tags = deriveTags(endpoint);

    console.log(`[TBA] GET ${endpoint}`);

    /* -------------------------- */
    /* 1. Cache-first fast path   */
    /* -------------------------- */
    if (!options?.forceRefresh) {
      const cached = await redis.get(cKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }

    /* -------------------------- */
    /* 2. Build headers           */
    /* -------------------------- */
    const headers: Record<string, string> = {
      "X-TBA-Auth-Key": this.authKey,
    };

    const etag = await redis.get(eKey);
    if (etag && !options?.forceRefresh) {
      headers["If-None-Match"] = etag;
    }

    /* -------------------------- */
    /* 3. Fetch from TBA          */
    /* -------------------------- */
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      headers,
      ...(options?.noStore
        ? { cache: "no-store" }
        : { next: { revalidate } }),
    });

    /* -------------------------- */
    /* 4. 304 → serve cache       */
    /* -------------------------- */
    if (res.status === 304) {
      const cached = await redis.get(cKey);

      if (cached) {
        return JSON.parse(cached);
      }

      // cache desync recovery
      return this.fetchAndCache(endpoint, cKey, eKey, tags, revalidate);
    }

    /* -------------------------- */
    /* 5. 200 → update cache      */
    /* -------------------------- */
    if (res.ok) {
      const data = await res.json();
      const newEtag = res.headers.get("ETag");

      await redis.set(cKey, JSON.stringify(data));

      if (newEtag) {
        await redis.set(eKey, newEtag);
      }

      /* -------------------------- */
      /* 6. register tags           */
      /* -------------------------- */
      if (tags.length) {
        const pipeline = redis.pipeline();

        for (const tag of tags) {
          pipeline.sadd(tagKey(tag), cKey);
        }

        await pipeline.exec();
      }

      return data;
    }

    throw new Error(`[TBA Client] ERROR ${endpoint} ${res.status}`);
  }

  /**
   * fallback fetch if cache/Etag mismatch occurs
   */
  private async fetchAndCache(
    endpoint: string,
    cKey: string,
    eKey: string,
    tags: string[],
    revalidate: number
  ) {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      headers: {
        "X-TBA-Auth-Key": this.authKey,
      },
      next: { revalidate },
    });

    if (!res.ok) {
      throw new Error(`[TBA fallback] ${endpoint} ${res.status}`);
    }

    const data = await res.json();
    const etag = res.headers.get("ETag");

    await redis.set(cKey, JSON.stringify(data));

    if (etag) {
      await redis.set(eKey, etag);
    }

    if (tags.length) {
      const pipeline = redis.pipeline();

      for (const tag of tags) {
        pipeline.sadd(tagKey(tag), cKey);
      }

      await pipeline.exec();
    }

    return data;
  }
}