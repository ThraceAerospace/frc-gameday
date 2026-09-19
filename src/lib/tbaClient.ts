import { redis } from "@/lib/redis";

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
    endpoint.endsWith("/matches") ||
    endpoint.endsWith("/matches/simple")
  );
}

function reconcileMatch<T extends { key?: string }>(
  incoming: T,
  cached: T | undefined,
): T {
  if (!cached) return incoming;

  const incomingHasResult = isMatchResultPresent(incoming);
  const cachedHasResult = isMatchResultPresent(cached);

  if (cachedHasResult && !incomingHasResult) {
    return cached;
  }

  return incoming;
}

function reconcileMatchData<T>(
  endpoint: string,
  incoming: T,
  cached: T,
): T {
  if (!isMatchEndpoint(endpoint)) {
    return incoming;
  }

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

  if (
    incoming &&
    cached &&
    typeof incoming === "object" &&
    typeof cached === "object" &&
    "key" in incoming &&
    "key" in cached
  ) {
    return reconcileMatch(incoming, cached) as T;
  }

  return incoming;
}

const BASE_URL = "https://www.thebluealliance.com/api/v3";

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
      tags.add(`event:${eventKey}:${parts[eventIdx + 2]}`);
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
      const eventKey = parts[teamEventIdx + 1];

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
    tags.add(`match:${parts[matchIdx + 1]}`);
  }

  return [...tags];
}

function getMaxAge(
  cacheControl: string | null,
): number | null {
  if (!cacheControl) return null;

  const match = cacheControl.match(
    /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i,
  );

  return match ? Number(match[1]) : null;
}

function parseCached<T>(
  raw: string,
): CacheEntry<T> | null {
  try {
    return JSON.parse(raw) as CacheEntry<T>;
  } catch {
    return null;
  }
}

export class TBAClient {
  constructor(
    private readonly authKey: string,
  ) {}

  /**
   * Mutate an existing Redis cache entry.
   *
   * Returns false if the endpoint isn't currently cached.
   *
   * We intentionally do not fetch from TBA here. A webhook should
   * be able to update Redis without causing another API request.
   */
  async mutateCached<T>(
    endpoint: string,
    mutate: (data: T) => T,
  ): Promise<boolean> {
    const key = cacheKey(endpoint);
    const raw = await redis.get(key);

    if (!raw) {
      return false;
    }

    const cached = parseCached<T>(raw);

    if (!cached) {
      console.warn(
        `[Client][TBA] invalid cache entry for ${endpoint}`,
      );

      await redis.del(key);
      return false;
    }

    const updated: CacheEntry<T> = {
      ...cached,
      data: mutate(cached.data),
      /*
       * Webhook data is newer than the cached API response.
       * Keep the existing freshness window rather than making
       * the webhook response immediately stale.
       */
      expiresAt: Math.max(
        cached.expiresAt,
        Date.now(),
      ),
    };

    await redis.set(
      key,
      JSON.stringify(updated),
    );

    console.log(
      `[Client][TBA] Redis cache mutated for ${endpoint}`,
    );

    return true;
  }

  /**
   * Replace an existing cache entry with authoritative webhook data.
   *
   * Does nothing if the endpoint isn't already cached.
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
   * Merge a webhook Match into any currently cached representation
   * of that match.
   */
  async mutateMatchCaches(
    match: {
      key?: string;
      event_key?: string;
      [key: string]: unknown;
    },
  ) {
    if (!match.key) {
      return;
    }

    const matchKey = match.key;

    await this.replaceCached(
      `/match/${matchKey}`,
      match,
    );

    if (!match.event_key) {
      return;
    }

    const eventKey = match.event_key;

    await this.mutateCached<any[]>(
      `/event/${eventKey}/matches`,
      (matches) =>
        matches.map((cachedMatch) =>
          cachedMatch.key === matchKey
            ? {
                ...cachedMatch,
                ...match,
              }
            : cachedMatch,
        ),
    );

    await this.mutateCached<any[]>(
      `/event/${eventKey}/matches/simple`,
      (matches) =>
        matches.map((cachedMatch) =>
          cachedMatch.key === matchKey
            ? {
                ...cachedMatch,
                ...match,
              }
            : cachedMatch,
        ),
    );

    const teamKeys = new Set<string>();

    for (const alliance of Object.values(
      (match.alliances ?? {}) as Record<
        string,
        { teams?: string[] }
      >,
    )) {
      for (const teamKey of alliance.teams ?? []) {
        teamKeys.add(teamKey);
      }
    }

    await Promise.all(
      [...teamKeys].flatMap((teamKey) => [
        this.mutateCached<any[]>(
          `/team/${teamKey}/event/${eventKey}/matches`,
          (matches) =>
            matches.map((cachedMatch) =>
              cachedMatch.key === matchKey
                ? {
                    ...cachedMatch,
                    ...match,
                  }
                : cachedMatch,
            ),
        ),

        this.mutateCached<any[]>(
          `/team/${teamKey}/event/${eventKey}/matches/simple`,
          (matches) =>
            matches.map((cachedMatch) =>
              cachedMatch.key === matchKey
                ? {
                    ...cachedMatch,
                    ...match,
                  }
                : cachedMatch,
            ),
        ),
      ]),
    );
  }

  /**
   * Merge partial upcoming_match webhook data into an existing
   * cached match.
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
    if (!data.match_key) {
      return;
    }

    const matchKey = data.match_key;

    const patch = {
      key: matchKey,
      event_key: data.event_key,
      team_keys: data.team_keys,
      scheduled_time: data.scheduled_time,
      predicted_time: data.predicted_time,
    };

    await this.mutateCached<any>(
      `/match/${matchKey}`,
      (match) => ({
        ...match,
        ...Object.fromEntries(
          Object.entries(patch).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      }),
    );

    if (!data.event_key) {
      return;
    }

    const eventKey = data.event_key;

    const updateArray = (matches: any[]) =>
      matches.map((match) =>
        match.key === matchKey
          ? {
              ...match,
              ...Object.fromEntries(
                Object.entries(patch).filter(
                  ([, value]) =>
                    value !== undefined,
                ),
              ),
            }
          : match,
      );

    await this.mutateCached<any[]>(
      `/event/${eventKey}/matches`,
      updateArray,
    );

    await this.mutateCached<any[]>(
      `/event/${eventKey}/matches/simple`,
      updateArray,
    );

    const teamKeys =
      data.team_keys ?? [];

    await Promise.all(
      teamKeys.flatMap((teamKey) => [
        this.mutateCached<any[]>(
          `/team/${teamKey}/event/${eventKey}/matches`,
          updateArray,
        ),

        this.mutateCached<any[]>(
          `/team/${teamKey}/event/${eventKey}/matches/simple`,
          updateArray,
        ),
      ]),
    );
  }

  async invalidateTag(tag: string) {
    const key = tagKey(tag);
    const members = await redis.smembers(key);

    if (!members?.length) return;

    const pipeline = redis.pipeline();

    for (const cache of members) {
      pipeline.del(cache);
    }

    pipeline.del(key);

    await pipeline.exec();

    console.log(
      `[Client][TBA] invalidated tag ${tag} (${members.length} entries)`,
    );
  }

  async invalidateTags(tags: string[]) {
    const uniqueTags = [...new Set(tags)];

    if (!uniqueTags.length) return;

    const pipeline = redis.pipeline();
    const cacheKeys = new Set<string>();
    const existingTagKeys: string[] = [];

    for (const tag of uniqueTags) {
      const key = tagKey(tag);
      const members = await redis.smembers(key);

      if (!members?.length) continue;

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

    console.log(
      `[Client][TBA] invalidated tags ${uniqueTags.join(", ")} (${cacheKeys.size} cache entries)`,
    );
  }

  async get<T>(
    endpoint: string,
    options?: {
      forceRefresh?: boolean;
    },
  ): Promise<T> {
    const cKey = cacheKey(endpoint);
    const tags = deriveTags(endpoint);

    const cachedRaw =
      await redis.get(cKey);

    let cached: CacheEntry<T> | null =
      null;

    if (cachedRaw) {
      cached = parseCached<T>(
        cachedRaw,
      );

      if (!cached) {
        console.warn(
          `[Client][TBA] invalid cache entry for ${endpoint}`,
        );

        await redis.del(cKey);
      }
    }

    if (
      cached &&
      !options?.forceRefresh &&
      Date.now() < cached.expiresAt
    ) {
      console.log(
        `[Client][TBA] Redis cache hit for ${endpoint}`,
      );

      return cached.data;
    }

    const headers: Record<
      string,
      string
    > = {
      "X-TBA-Auth-Key": this.authKey,
    };

    if (
      cached?.etag &&
      !options?.forceRefresh
    ) {
      headers["If-None-Match"] =
        cached.etag;

      console.log(
        `[Client][TBA] validating cached entry for ${endpoint}`,
      );
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
        throw new Error(
          `[Client][TBA] received 304 without Redis cache for ${endpoint}`,
        );
      }

      const maxAge =
        getMaxAge(
          res.headers.get(
            "Cache-Control",
          ),
        );

      if (maxAge === null) {
        throw new Error(
          `[Client][TBA] 304 response for ${endpoint} did not provide Cache-Control max-age`,
        );
      }

      await redis.expire(cKey, maxAge);

      const latestRaw = await redis.get(cKey);
      const latest = latestRaw
        ? parseCached<T>(latestRaw)
        : null;

      if (!latest) {
        throw new Error(
          "[Client][TBA] cache entry disappeared after 304 for " +
          endpoint,
        );
      }

      console.log(
        "[Client][TBA] 304 Not Modified for " +
          endpoint +
          "; Redis data unchanged, TTL refreshed to " +
          maxAge +
          "s",
      );

      return latest.data;
    }

    if (!res.ok) {
      throw new Error(
        `[Client][TBA] ERROR ${endpoint} ${res.status}`,
      );
    }

    const data =
      (await res.json()) as T;

    const reconciledData = cached
      ? reconcileMatchData(
          endpoint,
          data,
          cached.data,
        )
      : data;

    const maxAge =
      getMaxAge(
        res.headers.get(
          "Cache-Control",
        ),
      );

    if (maxAge === null) {
      throw new Error(
        `[Client][TBA] response for ${endpoint} did not provide Cache-Control max-age`,
      );
    }

    const entry: CacheEntry<T> = {
      data: reconciledData,
      etag: res.headers.get("ETag"),
      expiresAt:
        Date.now() +
        maxAge * 1000,
    };

    await redis.set(
      cKey,
      JSON.stringify(entry),
    );

    if (tags.length) {
      const pipeline =
        redis.pipeline();

      for (const tag of tags) {
        pipeline.sadd(
          tagKey(tag),
          cKey,
        );
      }

      await pipeline.exec();
    }

    console.log(
      `[Client][TBA] Redis cache updated for ${endpoint}; freshness ${maxAge}s`,
    );

    return reconciledData;
  }
}