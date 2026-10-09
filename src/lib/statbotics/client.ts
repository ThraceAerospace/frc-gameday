import { randomUUID } from "node:crypto";
import { redis } from "@/lib/cache/redis";
import type { StatboticsMatch } from "./types";

const DEFAULT_BASE_URL = "https://api-statbotics.iterativerefinement.com";
const MATCH_CACHE_TTL_SECONDS = 30 * 60;
const NOT_FOUND_CACHE_TTL_SECONDS = 5 * 60;
const MATCH_REFRESH_COOLDOWN_MS = 2 * 60 * 1000;
const REQUEST_LOCK_SECONDS = 20;
const CACHE_PREFIX = "cache:statbotics:match:";
const LOCK_PREFIX = "lock:statbotics:match:";

type CachedMatch = {
  fetchedAt: number;
  lastRefreshAt?: number;
  data: StatboticsMatch | null;
};

function matchCacheKey(matchKey: string) {
  return CACHE_PREFIX + matchKey;
}

function matchLockKey(matchKey: string) {
  return LOCK_PREFIX + matchKey;
}

async function readCache(matchKey: string): Promise<CachedMatch | null> {
  const raw = await redis.get(matchCacheKey(matchKey));
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "fetchedAt" in parsed &&
      typeof parsed.fetchedAt === "number" &&
      "data" in parsed
    ) {
      return parsed as CachedMatch;
    }
  } catch {
    // Treat malformed cache data as a miss.
  }

  await redis.del(matchCacheKey(matchKey));
  return null;
}

async function waitForCache(
  matchKey: string,
  previousFetchedAt: number | null,
): Promise<CachedMatch | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const cached = await readCache(matchKey);
    if (cached && (previousFetchedAt === null || cached.fetchedAt > previousFetchedAt)) {
      return cached;
    }
  }
  return readCache(matchKey);
}

async function releaseLock(lockKey: string, token: string) {
  await redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    lockKey,
    token,
  );
}

export class StatboticsClient {
  async getMatch(
    matchKey: string,
    options: { refresh?: boolean } = {},
  ): Promise<StatboticsMatch | null> {
    const cached = await readCache(matchKey);
    const sinceLastRefresh = cached?.lastRefreshAt == null
      ? Infinity
      : Date.now() - cached.lastRefreshAt;

    if (cached && (!options.refresh || sinceLastRefresh < MATCH_REFRESH_COOLDOWN_MS)) {
      return cached.data;
    }

    const lockKey = matchLockKey(matchKey);
    const token = randomUUID();
    const acquired = await redis.set(
      lockKey,
      token,
      "EX",
      REQUEST_LOCK_SECONDS,
      "NX",
    );

    if (acquired !== "OK") {
      if (cached) return cached.data;
      const concurrentResult = await waitForCache(matchKey, null);
      if (concurrentResult) return concurrentResult.data;
      throw new Error("A Statbotics request for this match is already in progress");
    }

    try {
      // Re-read after acquiring the lock: another request may have populated
      // the cache between our initial read and lock acquisition.
      const latest = await readCache(matchKey);
      const sinceLatestRefresh = latest?.lastRefreshAt == null
        ? Infinity
        : Date.now() - latest.lastRefreshAt;
      if (latest && (!options.refresh || sinceLatestRefresh < MATCH_REFRESH_COOLDOWN_MS)) {
        return latest.data;
      }

      const configuredBase = process.env.STATBOTICS_API_BASE_URL?.trim();
      const baseUrl = (configuredBase || DEFAULT_BASE_URL).replace(/\/+$/, "");
      const response = await fetch(
        `${baseUrl}/v3/match/${encodeURIComponent(matchKey)}`,
        { cache: "no-store" },
      );

      if (response.status === 404) {
        const entry: CachedMatch = {
          fetchedAt: Date.now(),
          lastRefreshAt: options.refresh ? Date.now() : latest?.lastRefreshAt,
          data: null,
        };
        await redis.set(
          matchCacheKey(matchKey),
          JSON.stringify(entry),
          "EX",
          NOT_FOUND_CACHE_TTL_SECONDS,
        );
        return null;
      }

      if (!response.ok) {
        throw new Error(`Statbotics request failed: ${response.status}`);
      }

      const data = await response.json() as StatboticsMatch;
      const entry: CachedMatch = {
        fetchedAt: Date.now(),
        lastRefreshAt: options.refresh ? Date.now() : latest?.lastRefreshAt,
        data,
      };
      await redis.set(
        matchCacheKey(matchKey),
        JSON.stringify(entry),
        "EX",
        MATCH_CACHE_TTL_SECONDS,
      );
      return data;
    } catch (error) {
      // A refresh failure should not discard a previously usable prediction.
      if (latestCachedFallback(cached)) return cached!.data;
      throw error;
    } finally {
      await releaseLock(lockKey, token);
    }
  }
}

function latestCachedFallback(cached: CachedMatch | null): cached is CachedMatch {
  return cached !== null;
}
