import { randomUUID } from "node:crypto";
import { redis } from "@/lib/cache/redis";
import { TBA } from "@/lib/tba/service";
import { Statbotics } from "@/lib/statbotics/service";
import { sortMatches } from "@/lib/tba/matchUtils";
import { buildAllianceResults, buildReviewFindings, buildTeamRows, mean, standardDeviation } from "./calculations";
import type { AnalyticsMatch, EventAnalyticsResponse } from "./types";

const CACHE_TTL_SECONDS = 60;
const LOCK_TTL_SECONDS = 45;
const CACHE_PREFIX = "cache:insights:event:";
const LOCK_PREFIX = "lock:insights:event:";
const MAX_PAGE_SIZE = 40;
const CONCURRENCY = 4;

async function releaseLock(key: string, token: string) {
  await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token);
}

async function withConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

export async function getEventAnalytics(eventKey: string, offset = 0, requestedLimit = 20): Promise<EventAnalyticsResponse> {
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(requestedLimit) || 20));
  const safeOffset = Math.max(0, Math.floor(offset) || 0);
  const cacheKey = `${CACHE_PREFIX}${eventKey}:${safeOffset}:${limit}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached) as EventAnalyticsResponse; } catch { await redis.del(cacheKey); }
  }

  const lockKey = `${LOCK_PREFIX}${eventKey}:${safeOffset}:${limit}`;
  const token = randomUUID();
  const acquired = await redis.set(lockKey, token, "EX", LOCK_TTL_SECONDS, "NX");
  if (acquired !== "OK") {
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const result = await redis.get(cacheKey);
      if (result) return JSON.parse(result) as EventAnalyticsResponse;
    }
    throw new Error("An analytics request for this event page is already in progress");
  }

  try {
    const [event, teams, rawMatches, oprs] = await Promise.all([
      TBA.getEvent(eventKey), TBA.getTeamsAtEvent(eventKey), TBA.getEventMatches(eventKey), TBA.getEventOPRs(eventKey),
    ]);
    const matches = sortMatches(rawMatches);
    const selectedMatches = matches.slice(safeOffset, safeOffset + limit);
    const analyticsMatches = await withConcurrency(selectedMatches, CONCURRENCY, async (match): Promise<AnalyticsMatch> => {
      try {
        const statbotics = await Statbotics.getMatch(match.key);
        return { match, statbotics, statboticsStatus: statbotics ? "ready" : "unavailable" };
      } catch {
        return { match, statbotics: null, statboticsStatus: "unavailable" };
      }
    });

    const allianceResults = buildAllianceResults(analyticsMatches);
    const teamRows = buildTeamRows(teams, oprs, analyticsMatches, allianceResults);
    const findings = buildReviewFindings(analyticsMatches, allianceResults, teamRows);
    const residuals = allianceResults.flatMap((result) => result.residual === null ? [] : [result.residual]);
    const payload: EventAnalyticsResponse = {
      event, teams: teamRows, matches: analyticsMatches, allianceResults, findings,
      matchCount: matches.length, loadedMatchCount: analyticsMatches.length,
      offset: safeOffset, limit, hasMore: safeOffset + selectedMatches.length < matches.length,
      residualStats: { mean: mean(residuals), standardDeviation: standardDeviation(residuals), sampleSize: residuals.length },
    };
    await redis.set(cacheKey, JSON.stringify(payload), "EX", CACHE_TTL_SECONDS);
    return payload;
  } finally {
    if (acquired === "OK") await releaseLock(lockKey, token);
  }
}
