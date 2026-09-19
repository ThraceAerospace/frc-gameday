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

/*
 * Diagnostic cache snapshot information.
 *
 * We deliberately inspect the match frontier without knowing
 * anything about the specific current match. This lets the
 * logging work at any event.
 */
function summarizeData(data: unknown) {
  if (!Array.isArray(data)) {
    return {
      kind: typeof data,
      length: null,
      firstKey: null,
      lastKey: null,
      playedCount: null,
      lastPlayedKey: null,
      firstUnplayedKey: null,
    };
  }

  const matches = data as Array<{
    key?: string;
    actual_time?: number;
    time?: number;
    predicted_time?: number;
    match_number?: number;
    comp_level?: string;
  }>;

  const played = matches.filter(
    (match) => Boolean(match.actual_time),
  );

  const unplayed = matches.filter(
    (match) => !match.actual_time,
  );

  const lastPlayed =
    played.length > 0
      ? played[played.length - 1]
      : null;

  const firstUnplayed =
    unplayed.length > 0
      ? unplayed[0]
      : null;

  return {
    kind: "array",
    length: matches.length,

    firstKey:
      matches[0]?.key ?? null,

    lastKey:
      matches[matches.length - 1]?.key ??
      null,

    playedCount: played.length,

    lastPlayedKey:
      lastPlayed?.key ?? null,

    lastPlayedActualTime:
      lastPlayed?.actual_time ?? null,

    firstUnplayedKey:
      firstUnplayed?.key ?? null,

    firstUnplayedTime:
      firstUnplayed?.time ??
      firstUnplayed?.predicted_time ??
      null,
  };
}

function summarizeCache<T>(
  cached: CacheEntry<T> | null,
) {
  if (!cached) {
    return null;
  }

  return {
    etag: cached.etag,
    expiresAt: cached.expiresAt,
    expiresInMs:
      cached.expiresAt - Date.now(),
    data: summarizeData(
      cached.data,
    ),
  };
}

let operationCounter = 0;

function operationId(
  type: string,
) {
  operationCounter += 1;

  return `${type}-${operationCounter}`;
}

export class TBAClient {
  constructor(
    private readonly authKey: string,
  ) {}

  /**
   * Mutate an existing Redis cache entry in place.
   *
   * DIAGNOSTIC VERSION:
   *
   * Logs the Redis snapshot before mutation and the resulting
   * snapshot after mutation so we can detect lost updates.
   */
  async mutateCached<T>(
    endpoint: string,
    mutate: (data: T) => T,
  ): Promise<boolean> {
    const operation =
      operationId("MUTATE");

    const key = cacheKey(endpoint);

    const startedAt =
      Date.now();

    console.log(
      "[Client][TBA][CACHE MUTATE START]",
      {
        operation,
        endpoint,
        key,
        startedAt:
          new Date(
            startedAt,
          ).toISOString(),
      },
    );

    const raw = await redis.get(key);

    if (raw === null) {
      console.log(
        "[Client][TBA][CACHE MUTATE MISS]",
        {
          operation,
          endpoint,
          key,
          durationMs:
            Date.now() -
            startedAt,
        },
      );

      return false;
    }

    const cached =
      parseCached<T>(raw);

    if (!cached) {
      console.warn(
        "[Client][TBA][CACHE MUTATE INVALID]",
        {
          operation,
          endpoint,
          key,
        },
      );

      await redis.del(key);

      return false;
    }

    console.log(
      "[Client][TBA][CACHE MUTATE READ]",
      {
        operation,
        endpoint,
        key,
        snapshot:
          summarizeCache(cached),
      },
    );

    try {
      const mutatedData =
        mutate(cached.data);

      const updated: CacheEntry<T> = {
        ...cached,
        data: mutatedData,
      };

      console.log(
        "[Client][TBA][CACHE MUTATE BEFORE WRITE]",
        {
          operation,
          endpoint,
          key,

          before:
            summarizeData(
              cached.data,
            ),

          after:
            summarizeData(
              updated.data,
            ),

          expiresAt:
            updated.expiresAt,
        },
      );

      await redis.set(
        key,
        JSON.stringify(updated),
      );

      /*
       * Immediately read the value back.
       *
       * This tells us whether our own write actually became
       * the current Redis value, or whether another concurrent
       * operation replaced it before this read.
       */
      const verificationRaw =
        await redis.get(key);

      const verification =
        verificationRaw
          ? parseCached<T>(
              verificationRaw,
            )
          : null;

      console.log(
        "[Client][TBA][CACHE MUTATE WRITE COMPLETE]",
        {
          operation,
          endpoint,
          key,

          written:
            summarizeCache(
              updated,
            ),

          redisAfterWrite:
            summarizeCache(
              verification,
            ),

          writeMatchesVerification:
            JSON.stringify(
              verification?.data,
            ) ===
            JSON.stringify(
              updated.data,
            ),

          durationMs:
            Date.now() -
            startedAt,
        },
      );

      return true;
    } catch (error) {
      console.error(
        "[Client][TBA][CACHE MUTATE ERROR]",
        {
          operation,
          endpoint,
          key,
          error,
          durationMs:
            Date.now() -
            startedAt,
        },
      );

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
      console.warn(
        "[Client][TBA][MATCH MUTATION SKIPPED]",
        {
          reason:
            "missing match.key or match.event_key",
          match,
        },
      );

      return;
    }

    const matchKey = match.key;
    const eventKey = match.event_key;

    console.log(
      "[Client][TBA][MATCH MUTATION]",
      {
        matchKey,
        eventKey,
      },
    );

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

    await this.mutateCached<any[]>(
      `/event/${eventKey}/matches/simple`,
      updateMatches,
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
      [...teamKeys].flatMap(
        (teamKey) => [
          this.mutateCached<any[]>(
            `/team/${teamKey}/event/${eventKey}/matches`,
            updateMatches,
          ),

          this.mutateCached<any[]>(
            `/team/${teamKey}/event/${eventKey}/matches/simple`,
            updateMatches,
          ),
        ],
      ),
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
    if (!data.match_key) {
      console.warn(
        "[Client][TBA][UPCOMING MUTATION SKIPPED]",
        {
          reason:
            "missing match_key",
        },
      );

      return;
    }

    if (!data.event_key) {
      console.warn(
        "[Client][TBA][UPCOMING MUTATION SKIPPED]",
        {
          reason:
            "missing event_key",
        },
      );

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

    console.log(
      "[Client][TBA][UPCOMING MUTATION]",
      {
        matchKey,
        eventKey,
        patch: cleanPatch,
      },
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

    await this.mutateCached<any[]>(
      `/event/${eventKey}/matches/simple`,
      updateMatches,
    );

    const teamKeys =
      data.team_keys ?? [];

    await Promise.all(
      teamKeys.flatMap(
        (teamKey) => [
          this.mutateCached<any[]>(
            `/team/${teamKey}/event/${eventKey}/matches`,
            updateMatches,
          ),

          this.mutateCached<any[]>(
            `/team/${teamKey}/event/${eventKey}/matches/simple`,
            updateMatches,
          ),
        ],
      ),
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

    console.log(
      `[Client][TBA] invalidated tag ${tag} (${members.length} entries)`,
    );
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

    console.log(
      `[Client][TBA] invalidated tags ${uniqueTags.join(", ")} (${cacheKeys.size} cache entries)`,
    );
  }

  /**
   * Get data from Redis when fresh, otherwise fetch it from TBA.
   *
   * DIAGNOSTIC VERSION:
   *
   * Every cache read, TBA request, and Redis write is logged.
   */
  async get<T>(
    endpoint: string,
    options?: {
      forceRefresh?: boolean;
    },
  ): Promise<T> {
    const operation =
      operationId("GET");

    const cKey =
      cacheKey(endpoint);

    const tags =
      deriveTags(endpoint);

    const startedAt =
      Date.now();

    console.log(
      "[Client][TBA][GET START]",
      {
        operation,
        endpoint,
        key: cKey,
        forceRefresh:
          Boolean(
            options?.forceRefresh,
          ),
        startedAt:
          new Date(
            startedAt,
          ).toISOString(),
      },
    );

    const cachedRaw =
      await redis.get(cKey);

    let cached:
      | CacheEntry<T>
      | null = null;

    if (cachedRaw) {
      cached =
        parseCached<T>(
          cachedRaw,
        );

      if (!cached) {
        console.warn(
          "[Client][TBA][GET INVALID CACHE]",
          {
            operation,
            endpoint,
            key: cKey,
          },
        );

        await redis.del(cKey);
      }
    }

    console.log(
      "[Client][TBA][GET REDIS READ]",
      {
        operation,
        endpoint,
        key: cKey,

        cacheExists:
          cached !== null,

        snapshot:
          summarizeCache(cached),

        now: Date.now(),
      },
    );

    if (
      cached &&
      !options?.forceRefresh &&
      Date.now() < cached.expiresAt
    ) {
      console.log(
        "[Client][TBA][GET CACHE HIT]",
        {
          operation,
          endpoint,
          key: cKey,

          snapshot:
            summarizeCache(
              cached,
            ),

          durationMs:
            Date.now() -
            startedAt,
        },
      );

      return cached.data;
    }

    const headers: Record<
      string,
      string
    > = {
      "X-TBA-Auth-Key":
        this.authKey,
    };

    if (
      cached?.etag &&
      !options?.forceRefresh
    ) {
      headers["If-None-Match"] =
        cached.etag;

      console.log(
        "[Client][TBA][GET VALIDATE]",
        {
          operation,
          endpoint,
          key: cKey,
          etag: cached.etag,
          snapshot:
            summarizeCache(
              cached,
            ),
        },
      );
    } else {
      console.log(
        "[Client][TBA][GET FETCH]",
        {
          operation,
          endpoint,
          key: cKey,

          reason: options?.forceRefresh
            ? "forceRefresh"
            : cached
              ? "cache expired"
              : "cache miss",

          cachedSnapshot:
            summarizeCache(
              cached,
            ),
        },
      );
    }

    const tbaStartedAt =
      Date.now();

    const res = await fetch(
      `${BASE_URL}${endpoint}`,
      {
        headers,
        cache: "no-store",
      },
    );

    const tbaCompletedAt =
      Date.now();

    console.log(
      "[Client][TBA][GET TBA RESPONSE]",
      {
        operation,
        endpoint,
        key: cKey,

        status: res.status,

        durationMs:
          tbaCompletedAt -
          tbaStartedAt,

        etag:
          res.headers.get(
            "ETag",
          ),

        cacheControl:
          res.headers.get(
            "Cache-Control",
          ),
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

      /*
       * A 304 means TBA confirms that the cached representation
       * is still current.
       *
       * Do not write the cached object back to Redis here.
       * The Redis value may have been mutated by a webhook while
       * the validation request was in flight.
       *
       * Only refresh the Redis TTL using the max-age supplied
       * by the 304 response.
       */
      await redis.expire(
        cKey,
        maxAge,
      );

      console.log(
        "[Client][TBA][GET 304 TTL REFRESH]",
        {
          operation,
          endpoint,
          key: cKey,
          maxAge,
          expiresInMs:
            maxAge * 1000,
        },
      );

      const latestRaw =
        await redis.get(cKey);

      const latest = latestRaw
        ? parseCached<T>(latestRaw)
        : null;

      if (!latest) {
        throw new Error(
          "[Client][TBA] cache entry disappeared after 304 for " +
            endpoint,
        );
      }

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

    console.log(
      "[Client][TBA][GET TBA DATA]",
      {
        operation,
        endpoint,
        key: cKey,

        data:
          summarizeData(
            data,
          ),
      },
    );

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

    /*
     * The TBA request may have taken long enough for a webhook
     * to mutate Redis while the request was in flight.
     *
     * If Redis changed since the request started, the Redis value
     * is newer than the snapshot we used for this TBA request.
     *
     * Do not overwrite that value with the TBA response.
     */
    const latestRaw =
      await redis.get(cKey);

    if (latestRaw !== cachedRaw) {
      const latestCached =
        latestRaw
          ? parseCached<T>(
              latestRaw,
            )
          : null;

      console.warn(
        "[Client][TBA][GET REDIS CHANGED DURING FETCH]",
        {
          operation,
          endpoint,
          key: cKey,

          original:
            cached
              ? summarizeCache(
                  cached,
                )
              : null,

          current:
            summarizeCache(
              latestCached,
            ),

          tba:
            summarizeCache({
              data,
              etag:
                res.headers.get(
                  "ETag",
                ),
              expiresAt:
                Date.now() +
                maxAge * 1000,
            }),
        },
      );

      if (latestCached) {
        console.log(
          "[Client][TBA][GET PRESERVING CURRENT REDIS]",
          {
            operation,
            endpoint,
            key: cKey,

            returned:
              summarizeData(
                latestCached.data,
              ),

            durationMs:
              Date.now() -
              startedAt,
          },
        );

        return latestCached.data;
      }

      console.warn(
        "[Client][TBA][GET REDIS CHANGED BUT INVALID]",
        {
          operation,
          endpoint,
          key: cKey,
        },
      );
    }

    const entry:
      CacheEntry<T> = {
      data: reconciledData,
      etag:
        res.headers.get(
          "ETag",
        ),
      expiresAt:
        Date.now() +
        maxAge * 1000,
    };

    console.log(
      "[Client][TBA][GET BEFORE REDIS WRITE]",
      {
        operation,
        endpoint,
        key: cKey,

        previousCached:
          summarizeCache(
            cached,
          ),

        newEntry:
          summarizeCache(
            entry,
          ),
      },
    );

    await redis.set(
      cKey,
      JSON.stringify(entry),
    );

    const verificationRaw =
      await redis.get(cKey);

    const verification =
      verificationRaw
        ? parseCached<T>(
            verificationRaw,
          )
        : null;

    console.log(
      "[Client][TBA][GET WRITE COMPLETE]",
      {
        operation,
        endpoint,
        key: cKey,

        written:
          summarizeCache(
            entry,
          ),

        redisAfterWrite:
          summarizeCache(
            verification,
          ),

        writeMatchesVerification:
          JSON.stringify(
            verification?.data,
          ) ===
          JSON.stringify(
            entry.data,
          ),
      },
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
      "[Client][TBA][GET COMPLETE]",
      {
        operation,
        endpoint,
        key: cKey,

        returned:
          summarizeData(data),

        durationMs:
          Date.now() -
          startedAt,
      },
    );

    return reconciledData;
  }
}