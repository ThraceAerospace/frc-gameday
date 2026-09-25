import { redis } from "@/lib/cache/redis";

function isMatchResultPresent(match: {
  actual_time?: number | null;
  post_result_time?: number | null;
  score_breakdown?: unknown;
  alliances?: {
    red?: { score?: number | null };
    blue?: { score?: number | null };
  };
}) {
  return Boolean(
    match.actual_time != null ||
      match.post_result_time != null ||
      match.score_breakdown != null ||
      (match.alliances?.red?.score != null &&
        match.alliances.red.score >= 0) ||
      (match.alliances?.blue?.score != null &&
        match.alliances.blue.score >= 0),
  );
}

function isMatchEndpoint(endpoint: string) {
  return (
    endpoint.startsWith("/match/") ||
    endpoint.endsWith("/matches")
  );
}

function reconcileMatch<T extends {
  key?: string;
  actual_time?: number | null;
  post_result_time?: number | null;
  score_breakdown?: unknown;
  alliances?: {
    red?: { score?: number | null };
    blue?: { score?: number | null };
  };
}>(
  incoming: T,
  cached: T | undefined,
): T {
  if (!cached) return incoming;
  const incomingHasResult = isMatchResultPresent(incoming);
  const cachedHasResult = isMatchResultPresent(cached);
  if (cachedHasResult && !incomingHasResult) return cached;
  return incoming;
}

function reconcileMatchData<T>(
  endpoint: string,
  incoming: T,
  cached: T,
): T {
  if (!isMatchEndpoint(endpoint)) return incoming;

  if (Array.isArray(incoming) && Array.isArray(cached)) {
    const cachedByKey = new Map<string, any>();
    for (const match of cached) {
      if (match?.key) cachedByKey.set(match.key, match);
    }

    const merged = incoming.map((match) =>
      reconcileMatch(match, cachedByKey.get(match?.key)),
    );

    const incomingKeys = new Set(
      incoming.map((match) => match?.key).filter(Boolean),
    );

    for (const match of cached) {
      if (match?.key && !incomingKeys.has(match.key)) {
        merged.push(match);
      }
    }

    return merged as T;
  }



  return incoming;
}

const BASE_URL =
  "https://www.thebluealliance.com/api/v3";

export type CacheEntry<T> = {
  data: T;
  etag: string | null;
  expiresAt: number;
};

function norm(endpoint: string) {
  return endpoint.replace(/\//g, ":");
}

export function cacheKey(endpoint: string) {
  return `cache${norm(endpoint)}`;
}

function tagKey(tag: string) {
  return `tag:${tag}`;
}

function deriveTags(endpoint: string): string[] {
  const parts = endpoint.split("/").filter(Boolean);
  const tags = new Set<string>();

  const eventIdx = parts.indexOf("event");

  if (eventIdx !== -1 && parts[eventIdx + 1]) {
    const eventKey = parts[eventIdx + 1];

    tags.add(`event:${eventKey}`);

    if (parts[eventIdx + 2]) {
      tags.add(
        `event:${eventKey}:${parts[eventIdx + 2]}`,
      );
    }
  }

  const teamIdx = parts.indexOf("team");

  if (teamIdx !== -1 && parts[teamIdx + 1]) {
    const teamKey = parts[teamIdx + 1];

    tags.add(`team:${teamKey}`);

    const teamEventIdx = teamIdx + 2;

    if (
      parts[teamEventIdx] === "event" &&
      parts[teamEventIdx + 1]
    ) {
      const eventKey =
        parts[teamEventIdx + 1];

      tags.add(
        `team:${teamKey}:event:${eventKey}`,
      );

      if (parts[teamEventIdx + 2]) {
        tags.add(
          `team:${teamKey}:event:${eventKey}:${parts[teamEventIdx + 2]}`,
        );
      }
    }
  }

  const matchIdx = parts.indexOf("match");

  if (matchIdx !== -1 && parts[matchIdx + 1]) {
    tags.add(
      `match:${parts[matchIdx + 1]}`,
    );
  }

  return [...tags];
}

function getMaxAge(
  cacheControl: string | null,
): number | null {
  if (!cacheControl) {
    return null;
  }

  const match = cacheControl.match(
    /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i,
  );

  return match ? Number(match[1]) : null;
}

function parseCached<T>(
  raw: string,
): CacheEntry<T> | null {
  try {
    const parsed = JSON.parse(raw);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("data" in parsed) ||
      !("expiresAt" in parsed)
    ) {
      return null;
    }

    return parsed as CacheEntry<T>;
  } catch {
    return null;
  }
}


export class TBAClient {
  constructor(
    private readonly authKey: string,
  ) {}

  /**
   * Mutate an existing Redis cache entry in place.
   *
   * Returns false if the endpoint isn't currently cached.
   */
  async mutateCached<T>(
    endpoint: string,
    mutate: (data: T) => T,
  ): Promise<boolean> {
    const key = cacheKey(endpoint);
    const raw = await redis.get(key);

    if (raw === null) return false;

    const cached = parseCached<T>(raw);

    if (!cached) {
      console.warn(`[Client][TBA] invalid cache entry for ${endpoint}`);
      await redis.del(key);
      return false;
    }

    try {
      const updated: CacheEntry<T> = {
        ...cached,
        data: mutate(cached.data),
      };

      await redis.set(key, JSON.stringify(updated));
      return true;
    } catch (error) {
      console.error(`[Client][TBA] cache mutation failed for ${endpoint}`, error);
      return false;
    }
  }

  /**
   * Replace the data in an existing Redis cache entry.
   */
  async replaceCached<T>(
    endpoint: string,
    data: T,
  ): Promise<boolean> {
    return this.mutateCached<T>(
      endpoint,
      () => data,
    );
  }

  /**
   * Update event/team match caches from a full match webhook.
   */
  async mutateMatchCaches(
    match: {
      key?: string;
      event_key?: string;
      [key: string]: unknown;
    },
  ) {
    if (!match.key || !match.event_key) {
      console.warn("[Client][TBA] match webhook missing key or event_key");
      return;
    }

    const matchKey = match.key;
    const eventKey = match.event_key;

    const updateMatches = (
      matches: any[],
    ) =>
      matches.map((cachedMatch) =>
        cachedMatch.key === matchKey
          ? {
              ...cachedMatch,
              ...match,
            }
          : cachedMatch,
      );

    await this.mutateCached<any[]>(
      `/event/${eventKey}/matches`,
      updateMatches,
    );


  }

  /**
   * Update cached match schedule information from an
   * upcoming_match webhook.
   */
  async mutateUpcomingMatch(
    data: {
      event_key?: string;
      match_key?: string;
      team_keys?: string[];
      scheduled_time?: number;
      predicted_time?: number;
    },
  ) {
    if (!data.match_key || !data.event_key) {
      console.warn("[Client][TBA] upcoming_match webhook missing match_key or event_key");
      return;
    }

    const matchKey = data.match_key;
    const eventKey = data.event_key;

    const patch = {
      key: matchKey,
      event_key: eventKey,
      team_keys: data.team_keys,
      scheduled_time:
        data.scheduled_time,
      predicted_time:
        data.predicted_time,
    };

    const cleanPatch = Object.fromEntries(
      Object.entries(patch).filter(
        ([, value]) =>
          value !== undefined,
      ),
    );


    const updateMatches = (
      matches: any[],
    ) =>
      matches.map((match) =>
        match.key === matchKey
          ? {
              ...match,
              ...cleanPatch,
            }
          : match,
      );

    await this.mutateCached<any[]>(
      `/event/${eventKey}/matches`,
      updateMatches,
    );


  }

  async invalidateTag(tag: string) {
    const key = tagKey(tag);
    const members = await redis.smembers(key);

    if (!members?.length) {
      return;
    }

    const pipeline = redis.pipeline();

    for (const cache of members) {
      pipeline.del(cache);
    }

    pipeline.del(key);

    await pipeline.exec();

  }

  async invalidateTags(tags: string[]) {
    const uniqueTags = [
      ...new Set(tags),
    ];

    if (!uniqueTags.length) {
      return;
    }

    const pipeline = redis.pipeline();
    const cacheKeys = new Set<string>();
    const existingTagKeys: string[] = [];

    for (const tag of uniqueTags) {
      const key = tagKey(tag);
      const members =
        await redis.smembers(key);

      if (!members?.length) {
        continue;
      }

      existingTagKeys.push(key);

      for (const cache of members) {
        cacheKeys.add(cache);
      }
    }

    for (const cache of cacheKeys) {
      pipeline.del(cache);
    }

    for (const key of existingTagKeys) {
      pipeline.del(key);
    }

    if (
      cacheKeys.size ||
      existingTagKeys.length
    ) {
      await pipeline.exec();
    }

  }

  /**
   * Get data from Redis when fresh, otherwise fetch it from TBA.
   */
  async get<T>(
    endpoint: string,
    options?: {
      forceRefresh?: boolean;
    },
  ): Promise<T> {
    const cKey = cacheKey(endpoint);
    const tags = deriveTags(endpoint);
    const cachedRaw = await redis.get(cKey);

    let cached: CacheEntry<T> | null = cachedRaw
      ? parseCached<T>(cachedRaw)
      : null;

    if (cachedRaw && !cached) {
      console.warn(`[Client][TBA] invalid cache entry for ${endpoint}`);
      await redis.del(cKey);
    }

    if (cached && !options?.forceRefresh && Date.now() < cached.expiresAt) {
      return cached.data;
    }

    const headers: Record<string, string> = {
      "X-TBA-Auth-Key": this.authKey,
    };

    if (cached?.etag && !options?.forceRefresh) {
      headers["If-None-Match"] = cached.etag;
    }

    const res = await fetch(
      `${BASE_URL}${endpoint}`,
      {
        headers,
        cache: "no-store",
      },
    );

    if (res.status === 304) {
      if (!cached) {
        throw new Error(`[Client][TBA] received 304 without Redis cache for ${endpoint}`);
      }

      const maxAge = getMaxAge(res.headers.get("Cache-Control"));
      if (maxAge === null) {
        throw new Error(`[Client][TBA] 304 response for ${endpoint} did not provide Cache-Control max-age`);
      }

      await redis.expire(cKey, maxAge);

      const latestRaw = await redis.get(cKey);
      const latest = latestRaw ? parseCached<T>(latestRaw) : null;

      if (!latest) {
        throw new Error("[Client][TBA] cache entry disappeared after 304 for " + endpoint);
      }

      return latest.data;
    }

    if (!res.ok) {
      throw new Error(`[Client][TBA] ERROR ${endpoint} ${res.status}`);
    }

    const data = (await res.json()) as T;
    const reconciledData = cached
      ? reconcileMatchData(endpoint, data, cached.data)
      : data;

    const maxAge = getMaxAge(res.headers.get("Cache-Control"));
    if (maxAge === null) {
      throw new Error(`[Client][TBA] response for ${endpoint} did not provide Cache-Control max-age`);
    }

    /*
     * The TBA request may have overlapped a webhook mutation.
     * Preserve a newer Redis value instead of overwriting it.
     */
    const latestRaw = await redis.get(cKey);

    if (latestRaw !== cachedRaw) {
      const latestCached = latestRaw ? parseCached<T>(latestRaw) : null;

      if (latestCached) {
        return latestCached.data;
      }
    }

    const entry: CacheEntry<T> = {
      data: reconciledData,
      etag: res.headers.get("ETag"),
      expiresAt: Date.now() + maxAge * 1000,
    };

    await redis.set(cKey, JSON.stringify(entry));

    if (tags.length) {
      const pipeline = redis.pipeline();
      for (const tag of tags) {
        pipeline.sadd(tagKey(tag), cKey);
      }
      await pipeline.exec();
    }

    return reconciledData;
  }

}