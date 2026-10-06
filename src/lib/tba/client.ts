import { redis } from "@/lib/cache/redis";
import type { TBAMatch } from "@/lib/tba/types";

const BASE_URL =
  "https://www.thebluealliance.com/api/v3";

export type CacheEntry<T> = {
  data: T;
  etag: string | null;
  expiresAt: number;
};

function norm(endpoint: string) {
  return endpoint.replace(/\//gg, ":");
}

export function cacheKey(endpoint: string) {
  return `cache${norm(endpoint)}`;
}

function getMaxAge(cacheControl: string | null): number | null {
  if (!cacheControl) {
    return null;
  }

  const match = cacheControl.match(
    /(?:^|,)\s*max-age\s*=\s*"?([0-9]+)"?/i,
  );

  return match ? Number(match[1]) : null;
}

function parseCached<T>(raw: string): CacheEntry<T> | null {
  try {
    const parsed: unknown = JSON.parse(raw);

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

function isMatchEndpoint(endpoint: string) {
  return (
    endpoint.startsWith("/match/") ||
    endpoint.endsWith("/matches")
  );
}

function hasMatchResult(match: TBAMatch) {
  return (
    match.actual_time != null ||
    match.post_result_time != null ||
    match.score_breakdown != null ||
    (match.alliances.red.score != null &&
      match.alliances.red.score >= 0) ||
    (match.alliances.blue.score != null &&
      match.alliances.blue.score >= 0)
  );
}

function reconcileMatch(
  incoming: TBAMatch,
  cached: TBAMatch | undefined,
): TBAMatch {
  if (!cached) return incoming;

  if (hasMatchResult(cached) && !hasMatchResult(incoming)) {
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

  if (!Array.isArray(incoming) || !Array.isArray(cached)) {
    return incoming;
  }

  const cachedMatches = cached as TBAMatch[];
  const incomingMatches = incoming as TBAMatch[];
  const cachedByKey = new Map<string, TBAMatch>();

  for (const match of cachedMatches) {
    if (match.key) {
      cachedByKey.set(match.key, match);
    }
  }

  const incomingKeys = new Set(
    incomingMatches
      .map((match) => match.key)
      .filter((key): key is string => Boolean(key)),
  );

  const merged = incomingMatches.map((match) =>
    reconcileMatch(match, match.key ? cachedByKey.get(match.key) : undefined),
  );

  for (const match of cachedMatches) {
    if (match.key && !incomingKeys.has(match.key)) {
      merged.push(match);
    }
  }

  return merged as T;
}

export class TBAClient {
  constructor(private readonly authKey: string) {}

  /**
   * Get data from Redis when fresh, otherwise fetch it from TBA.
   * TBA controls the cache lifetime through Cache-Control max-age.
   */
  async get<T>(
    endpoint: string,
    options?: { forceRefresh?: boolean },
  ): Promise<T> {
    const cKey = cacheKey(endpoint);
    const cachedRaw = await redis.get(cKey);
    const cached = cachedRaw
      ? parseCached<T>(cachedRaw)
      : null;

    if (cachedRaw && !cached) {
      console.warn(
        `[Client][TBA] invalid cache entry for ${endpoint}`,
      );
      await redis.del(cKey);
    }

    if (
      cached &&
      !options?.forceRefresh &&
      Date.now() < cached.expiresAt
    ) {
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
        throw new Error(
          `[Client][TBA] received 304 without Redis cache for ${endpoint}`,
        );
      }

      const maxAge = getMaxAge(
        res.headers.get("Cache-Control"),
      );

      if (maxAge === null) {
        throw new Error(
          `[Client][TBA] 304 response for ${endpoint} did not provide Cache-Control max-age`,
        );
      }

      const updated: CacheEntry<T> = {
        ...cached,
        expiresAt: Date.now() + maxAge * 1000,
      };

      await redis.set(cKey, JSON.stringify(updated));
      return updated.data;
    }

    if (!res.ok) {
      throw new Error(
        `[Client][TBA] ERROR ${endpoint} ${res.status}`,
      );
    }

    const data = (await res.json()) as T;
    const reconciledData = cached
      ? reconcileMatchData(endpoint, data, cached.data)
      : data;

    const maxAge = getMaxAge(
      res.headers.get("Cache-Control"),
    );

    if (maxAge === null) {
      throw new Error(
        `[Client][TBA] response for ${endpoint} did not provide Cache-Control max-age`,
      );
    }

    const entry: CacheEntry<T> = {
      data: reconciledData,
      etag: res.headers.get("ETag"),
      expiresAt: Date.now() + maxAge * 1000,
    };

    await redis.set(cKey, JSON.stringify(entry));
    return reconciledData;
  }
}
