import { randomUUID } from "node:crypto";
import { redis } from "@/lib/cache/redis";
import type {
  StatboticsMatch,
  StatboticsTeamEvent,
  StatboticsTeamYear,
} from "./types";

const DEFAULT_BASE_URL = "https://api.statbotics.io";
const MIN_REQUEST_INTERVAL_SECONDS = 10 * 60;
const MATCH_FALLBACK_TTL_SECONDS = 10 * 60;
const TEAM_YEAR_FALLBACK_TTL_SECONDS = 10 * 60;
const TEAM_EVENT_FALLBACK_TTL_SECONDS = 24 * 60 * 60;
const REQUEST_LOCK_SECONDS = 20;
const CACHE_PREFIX = "cache:statbotics:v3:";
const LOCK_PREFIX = "lock:statbotics:v3:";

type CachedResponse<T> = {
  data: T | null;
  etag: string | null;
  fetchedAt: number;
  lastRefreshAt: number;
  expiresAt: number;
};

type CacheOptions = {
  refresh?: boolean;
  fallbackTtlSeconds: number;
};

function cacheKey(endpoint: string) {
  return CACHE_PREFIX + endpoint.replace(/\//g, ":");
}

function lockKey(endpoint: string) {
  return LOCK_PREFIX + endpoint.replace(/\//g, ":");
}

function getMaxAge(cacheControl: string | null): number | null {
  if (!cacheControl) return null;
  const match = cacheControl.match(/(?:^|,)\s*max-age\s*=\s*"?([0-9]+)"?/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Respect Statbotics' advertised freshness, but never make requests more
 * frequently than our conservative shared-service floor. If max-age is
 * absent, use the endpoint-specific fallback.
 */
function getEffectiveTtlSeconds(
  cacheControl: string | null,
  fallbackTtlSeconds: number,
): number {
  const upstreamMaxAge = getMaxAge(cacheControl);
  return upstreamMaxAge ?? fallbackTtlSeconds;
}

function parseCached<T>(raw: string): CachedResponse<T> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("data" in parsed) ||
      !("fetchedAt" in parsed) ||
      typeof parsed.fetchedAt !== "number" ||
      !("lastRefreshAt" in parsed) ||
      typeof parsed.lastRefreshAt !== "number" ||
      !("expiresAt" in parsed) ||
      typeof parsed.expiresAt !== "number"
    ) return null;
    return parsed as CachedResponse<T>;
  } catch {
    return null;
  }
}

async function readCache<T>(endpoint: string): Promise<CachedResponse<T> | null> {
  const key = cacheKey(endpoint);
  const raw = await redis.get(key);
  if (!raw) return null;
  const cached = parseCached<T>(raw);
  if (cached) return cached;
  await redis.del(key);
  return null;
}

async function writeCache<T>(
  endpoint: string,
  entry: CachedResponse<T>,
  ttlSeconds: number,
) {
  await redis.set(cacheKey(endpoint), JSON.stringify(entry), "EX", Math.max(1, ttlSeconds));
}

async function waitForCache<T>(
  endpoint: string,
  previousFetchedAt: number | null,
): Promise<CachedResponse<T> | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const cached = await readCache<T>(endpoint);
    if (cached && (previousFetchedAt === null || cached.fetchedAt > previousFetchedAt)) {
      return cached;
    }
  }
  return readCache<T>(endpoint);
}

async function releaseLock(key: string, token: string) {
  await redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    key,
    token,
  );
}

export class StatboticsClient {
  async getMatch(
    matchKey: string,
    options: { refresh?: boolean } = {},
  ): Promise<StatboticsMatch | null> {
    return this.getCached<StatboticsMatch>(
      `/match/${encodeURIComponent(matchKey)}`,
      { refresh: options.refresh, fallbackTtlSeconds: MATCH_FALLBACK_TTL_SECONDS },
    );
  }

  async getTeamYear(team: number, year: number): Promise<StatboticsTeamYear | null> {
    return this.getCached<StatboticsTeamYear>(
      `/team_year/${team}/${year}`,
      { fallbackTtlSeconds: TEAM_YEAR_FALLBACK_TTL_SECONDS },
    );
  }

  async getTeamEvent(
    team: number,
    eventKey: string,
    options: { refresh?: boolean } = {},
  ): Promise<StatboticsTeamEvent | null> {
    return this.getCached<StatboticsTeamEvent>(
      `/team_event/${team}/${encodeURIComponent(eventKey)}`,
      { refresh: options.refresh, fallbackTtlSeconds: TEAM_EVENT_FALLBACK_TTL_SECONDS },
    );
  }

  private async getCached<T>(
    endpoint: string,
    options: CacheOptions,
  ): Promise<T | null> {
    const cached = await readCache<T>(endpoint);
    const now = Date.now();
    const withinRequestFloor = cached !== null &&
      now - cached.lastRefreshAt < MIN_REQUEST_INTERVAL_SECONDS * 1000;

    if (cached && !options.refresh && now < cached.expiresAt) return cached.data;
    if (cached && withinRequestFloor) return cached.data;

    const key = lockKey(endpoint);
    const token = randomUUID();
    const acquired = await redis.set(key, token, "EX", REQUEST_LOCK_SECONDS, "NX");

    if (acquired !== "OK") {
      if (cached) return cached.data;
      const concurrentResult = await waitForCache<T>(endpoint, null);
      if (concurrentResult) return concurrentResult.data;
      throw new Error("A Statbotics request for this resource is already in progress");
    }

    let fallback = cached;
    try {
      // Re-read after acquiring the lock to avoid duplicating a request that
      // completed between the first cache read and lock acquisition.
      const latest = await readCache<T>(endpoint);
      fallback = latest ?? fallback;
      const refreshedAt = Date.now();
      const latestWithinFloor = latest !== null &&
        refreshedAt - latest.lastRefreshAt < MIN_REQUEST_INTERVAL_SECONDS * 1000;

      if (latest && ((!options.refresh && refreshedAt < latest.expiresAt) || latestWithinFloor)) {
        return latest.data;
      }

      const configuredBase = process.env.STATBOTICS_API_BASE_URL?.trim();
      const baseUrl = (configuredBase || DEFAULT_BASE_URL).replace(/\/+$/, "");
      const headers: Record<string, string> = {};
      if (latest?.etag) headers["If-None-Match"] = latest.etag;

      const response = await fetch(baseUrl + "/v3" + endpoint, {
        headers,
        cache: "no-store",
      });
      const ttlSeconds = getEffectiveTtlSeconds(
        response.headers.get("Cache-Control"),
        options.fallbackTtlSeconds,
      );
      const fetchedAt = Date.now();

      if (response.status === 304) {
        if (!latest) throw new Error("Statbotics returned 304 without a cached representation");
        const entry: CachedResponse<T> = {
          ...latest,
          fetchedAt,
          lastRefreshAt: fetchedAt,
          expiresAt: fetchedAt + ttlSeconds * 1000,
          etag: response.headers.get("ETag") ?? latest.etag,
        };
        await writeCache(endpoint, entry, ttlSeconds);
        return entry.data;
      }

      if (response.status === 404) {
        const entry: CachedResponse<T> = {
          data: null,
          etag: response.headers.get("ETag"),
          fetchedAt,
          lastRefreshAt: fetchedAt,
          expiresAt: fetchedAt + ttlSeconds * 1000,
        };
        await writeCache(endpoint, entry, ttlSeconds);
        return null;
      }

      if (!response.ok) throw new Error(`Statbotics request failed: ${response.status}`);

      const data = await response.json() as T;
      const entry: CachedResponse<T> = {
        data,
        etag: response.headers.get("ETag"),
        fetchedAt,
        lastRefreshAt: fetchedAt,
        expiresAt: fetchedAt + ttlSeconds * 1000,
      };
      await writeCache(endpoint, entry, ttlSeconds);
      return data;
    } catch (error) {
      // Failed refreshes are throttled too. Preserve stale data if available,
      // and otherwise retain a short negative entry to prevent retry storms.
      const failedAt = Date.now();
      const failedEntry: CachedResponse<T> = fallback
        ? {
            ...fallback,
            lastRefreshAt: failedAt,
            expiresAt: failedAt + options.fallbackTtlSeconds * 1000,
          }
        : {
            data: null,
            etag: null,
            fetchedAt: failedAt,
            lastRefreshAt: failedAt,
            expiresAt: failedAt + options.fallbackTtlSeconds * 1000,
          };
      await writeCache(endpoint, failedEntry, options.fallbackTtlSeconds);
      if (fallback) return fallback.data;
      throw error;
    } finally {
      await releaseLock(key, token);
    }
  }
}
