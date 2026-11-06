import { randomUUID } from "node:crypto";
import { redis } from "@/lib/cache/redis";
import { TBA } from "@/lib/tba/service";
import { Statbotics } from "@/lib/statbotics/service";
import { sortMatches } from "@/lib/tba/matchUtils";
import { buildAllianceResults, buildReviewFindings, buildTeamRows, mean, standardDeviation } from "./calculations";
import type { AnalyticsMatch, EventAnalyticsResponse } from "./types";

const CACHE_TTL_SECONDS = 60;
const LOCK_TTL_SECONDS = 90;
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

export async function getEventAnalytics(eventKey: string, offset = 0, requestedLimit = 20, liveMatchKey: string | null = null): Promise<EventAnalyticsResponse> {
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(requestedLimit) || 20));
  const safeOffset = Math.max(0, Math.floor(offset) || 0);
  const cacheKey = `${CACHE_PREFIX}${eventKey}:${safeOffset}:${limit}`;
  const cached = liveMatchKey ? null : await redis.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached) as EventAnalyticsResponse; } catch { await redis.del(cacheKey); }
  }

  const lockKey = `${LOCK_PREFIX}${eventKey}:${safeOffset}:${limit}:${liveMatchKey ?? "base"}`;
  const token = randomUUID();
  let acquired = await redis.set(lockKey, token, "EX", LOCK_TTL_SECONDS, "NX");
  if (acquired !== "OK") {
    // Another request may be building this page. Prefer its cached result,
    // but if it fails and releases the lock, take over instead of returning
    // a spurious 502 to every waiting request.
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const result = liveMatchKey ? null : await redis.get(cacheKey);
      if (result) {
        try {
          return JSON.parse(result) as EventAnalyticsResponse;
        } catch {
          await redis.del(cacheKey);
        }
      }
      acquired = await redis.set(lockKey, token, "EX", LOCK_TTL_SECONDS, "NX");
      if (acquired === "OK") break;
    }
    if (acquired !== "OK") {
      throw new Error("An analytics request for this event page is still in progress");
    }
  }

  try {
    const [event, teams, rawMatches, oprs] = await Promise.all([
      TBA.getEvent(eventKey), TBA.getTeamsAtEvent(eventKey), TBA.getEventMatches(eventKey), TBA.getEventOPRs(eventKey),
    ]);
    const matches = sortMatches(rawMatches);
    const pageMatches = matches.slice(safeOffset, safeOffset + limit);
    const selectedMatches = liveMatchKey && !pageMatches.some((match) => match.key === liveMatchKey)
      ? [...pageMatches, ...matches.filter((match) => match.key === liveMatchKey)]
      : pageMatches;
    const analyticsMatches = await withConcurrency(selectedMatches, CONCURRENCY, async (match): Promise<AnalyticsMatch> => {
      try {
        const statbotics = await Statbotics.getMatch(match.key);
        return { match, statbotics, statboticsStatus: statbotics ? "ready" : "unavailable" };
      } catch {
        return { match, statbotics: null, statboticsStatus: "unavailable" };
      }
    });

    const allianceResults = buildAllianceResults(analyticsMatches);
    const teamRows = buildTeamRows(teams, oprs, analyticsMatches);
    const findings = buildReviewFindings(analyticsMatches, allianceResults, teamRows);
    const residuals = allianceResults.flatMap((result) => result.residual === null ? [] : [result.residual]);
    const payload: EventAnalyticsResponse = {
      event, teams: teamRows, matches: analyticsMatches, allianceResults, findings,
      matchCount: matches.length, loadedMatchCount: analyticsMatches.length,
      offset: safeOffset, limit, hasMore: safeOffset + pageMatches.length < matches.length,
      residualStats: { mean: mean(residuals), standardDeviation: standardDeviation(residuals), sampleSize: residuals.length },
      predictionStats: (() => {
      const errors = allianceResults.flatMap((item) => item.residual === null ? [] : [item.residual]);
      const winChecks = analyticsMatches.flatMap((record) => {
        const probability = record.statbotics?.pred?.red_win_prob ?? record.statbotics?.prediction?.red_win_prob;
        const winner = record.match.winning_alliance;
        if (typeof probability !== "number" || (winner !== "red" && winner !== "blue")) return [];
        return [((probability >= 0.5 ? "red" : "blue") === winner) ? 1 : 0];
      });
      return {
        allianceCount: errors.length,
        meanAbsoluteError: errors.length ? errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length : null,
        rootMeanSquareError: errors.length ? Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length) : null,
        meanResidual: mean(errors),
        within25Count: errors.filter((value) => Math.abs(value) <= 25).length,
        winPredictionCount: winChecks.length,
        winPredictionAccuracy: winChecks.length ? winChecks.reduce((sum, value) => sum + value, 0) / winChecks.length : null,
      };
    })(),
      collection: { state: safeOffset + pageMatches.length >= matches.length ? "complete" : "collecting", processedMatchCount: analyticsMatches.length, totalMatchCount: matches.length, unavailableMatchCount: analyticsMatches.filter((record) => record.statboticsStatus === "unavailable").length, updatedAt: Date.now() },
    };
    if (!liveMatchKey) await redis.set(cacheKey, JSON.stringify(payload), "EX", CACHE_TTL_SECONDS);
    return payload;
  } finally {
    if (acquired === "OK") {
      try {
        await releaseLock(lockKey, token);
      } catch (error) {
        // The lock has a finite TTL; don't mask the original request failure
        // if Redis is temporarily unavailable during cleanup.
        console.error("[Insights] failed to release event analytics lock", eventKey, error);
      }
    }
  }
}
