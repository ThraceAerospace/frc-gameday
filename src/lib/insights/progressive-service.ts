import { randomUUID } from "node:crypto";
import { redis } from "@/lib/cache/redis";
import { TBA } from "@/lib/tba/service";
import { Statbotics } from "@/lib/statbotics/service";
import { sortMatches } from "@/lib/tba/matchUtils";
import { buildAllianceResults, buildPlayoffAnalysis, buildQualificationAnalysis, buildQualificationAnomalies, buildReviewFindings, buildTeamInsights, buildTeamRows, mean, standardDeviation } from "./calculations";
import type { AnalyticsMatch, EventAnalyticsResponse } from "./types";
import type { TBAEliminationAlliance, TBAEvent, TBAEventOPRs, TBAEventRanking, TBAMatch, TBATeam } from "@/lib/tba/types";

const JOB_TTL_SECONDS = 365 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 55;
const LOCK_PREFIX = "lock:insights:progressive:";
const JOB_PREFIX = "insights:progressive:";

type Job = {
  event: TBAEvent;
  teams: TBATeam[];
  oprs: TBAEventOPRs | null;
  rankings: TBAEventRanking | null;
  playoffAlliances?: TBAEliminationAlliance[] | null;
  playoffAlliancesRefreshedAt?: number;
  matches: TBAMatch[];
  records: Record<string, AnalyticsMatch>;
  attempts: Record<string, number>;
  state: "queued" | "collecting" | "complete" | "partial";
  updatedAt: number;
  scheduleRefreshedAt?: number;
  statboticsFetchError?: string | null;
  statboticsLoadedAt?: number;
};

function jobKey(eventKey: string) {
  return JOB_PREFIX + eventKey;
}

async function readJob(eventKey: string): Promise<Job | null> {
  const raw = await redis.get(jobKey(eventKey));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Job;
    if (!value.event || !Array.isArray(value.matches) || !value.records || !value.attempts) {
      await redis.del(jobKey(eventKey));
      return null;
    }
    return value;
  } catch {
    await redis.del(jobKey(eventKey));
    return null;
  }
}

async function writeJob(eventKey: string, job: Job) {
  job.updatedAt = Date.now();
  await redis.set(jobKey(eventKey), JSON.stringify(job), "EX", JOB_TTL_SECONDS);
}

function buildPayload(job: Job): EventAnalyticsResponse {
  const matchOrder = new Map(job.matches.map((match, index) => [match.key, index]));
  const analyticsMatches = Object.values(job.records).sort(
    (a, b) => (matchOrder.get(a.match.key) ?? 0) - (matchOrder.get(b.match.key) ?? 0),
  );
  const allianceResults = buildAllianceResults(analyticsMatches, job.event.playoff_type);
  const teams = buildTeamRows(job.teams, job.oprs, analyticsMatches);
  const findings = buildReviewFindings(analyticsMatches, allianceResults, teams, job.matches);
  const qualificationAnomalies = buildQualificationAnomalies(analyticsMatches, allianceResults, job.event.playoff_type);
  const playoffAnalysis = buildPlayoffAnalysis(allianceResults, job.playoffAlliances ?? null);
  const teamInsights = buildTeamInsights(analyticsMatches, allianceResults, teams, job.rankings, job.event.playoff_type);
  const residuals = allianceResults.flatMap((result) => result.residual === null ? [] : [result.residual]);
  const unavailableMatchCount = analyticsMatches.filter((record) => record.statboticsStatus === "unavailable").length;
  return {
    event: job.event,
    rankings: job.rankings,
    teams,
    matches: analyticsMatches,
    allianceResults,
    findings,
    qualificationAnomalies,
    qualificationAnalysis: buildQualificationAnalysis(analyticsMatches, job.matches, allianceResults, job.event.playoff_type),
    playoffAnalysis,
    teamInsights,
    matchCount: job.matches.length,
    loadedMatchCount: analyticsMatches.length,
    offset: 0,
    limit: job.matches.length,
    hasMore: false,
    residualStats: {
      mean: mean(residuals),
      standardDeviation: standardDeviation(residuals),
      sampleSize: residuals.length,
    },
    predictionStats: (() => {
      const errors = allianceResults.flatMap((item) => item.residual === null ? [] : [item.residual]);
      const winChecks = analyticsMatches.flatMap((record) => {
        const probability = record.statbotics?.pred?.red_win_prob;
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
    collection: {
      state: job.state,
      processedMatchCount: analyticsMatches.length,
      totalMatchCount: job.matches.length,
      unavailableMatchCount,
      statboticsFetchError: job.statboticsFetchError ?? null,
      updatedAt: job.updatedAt,
    },
  };
}

export async function getEventAnalyticsSnapshot(eventKey: string): Promise<EventAnalyticsResponse> {
  let job = await readJob(eventKey);
  if (!job) {
    const [event, teams, matches, oprs, rankings, playoffAlliances] = await Promise.all([
      TBA.getEvent(eventKey),
      TBA.getTeamsAtEvent(eventKey),
      TBA.getEventMatches(eventKey),
      TBA.getEventOPRs(eventKey),
      TBA.getEventRankings(eventKey).catch(() => null),
      TBA.getEventPlayoffAlliances(eventKey).catch(() => null),
    ]);
    job = {
      event,
      teams,
      oprs,
      rankings,
      playoffAlliances,
      matches: sortMatches(matches),
      records: {},
      attempts: {},
      state: "queued",
      updatedAt: Date.now(),
      scheduleRefreshedAt: Date.now(),
      playoffAlliancesRefreshedAt: Date.now(),
    };
    await writeJob(eventKey, job);
  }
  return buildPayload(job);
}

export async function advanceEventAnalytics(eventKey: string, forceRefresh = false): Promise<void> {
  const lockKey = LOCK_PREFIX + eventKey;
  const token = randomUUID();
  const acquired = await redis.set(lockKey, token, "EX", LOCK_TTL_SECONDS, "NX");
  if (acquired !== "OK") return;

  try {
    let job = await readJob(eventKey);
    if (!job) return;
    // A persisted historical snapshot is immutable until the user explicitly
    // requests a refresh. Avoid even repeating collection work on page opens.
    if (!forceRefresh && job.statboticsLoadedAt) return;
    if (forceRefresh) {
      job.records = {};
      job.attempts = {};
      job.statboticsLoadedAt = undefined;
      job.statboticsFetchError = null;
    }
    job.state = "collecting";
    // The dashboard is a persisted snapshot: TBA and Statbotics are only
    // reacquired when the user explicitly presses Refresh data.
    if (forceRefresh) {
      try {
        const [latestMatchesRaw, latestOprs, latestRankings] = await Promise.all([TBA.getEventMatches(eventKey), TBA.getEventOPRs(eventKey), TBA.getEventRankings(eventKey).catch(() => null)]);
        const latestMatches = sortMatches(latestMatchesRaw);
        job.oprs = latestOprs;
        job.rankings = latestRankings;
        job.playoffAlliances = await TBA.getEventPlayoffAlliances(eventKey).catch(() => job!.playoffAlliances ?? null);
        job.playoffAlliancesRefreshedAt = Date.now();
        const existing = new Map(job.matches.map((match) => [match.key, match]));
        for (const match of latestMatches) {
          const prior = existing.get(match.key);
          if (!prior) existing.set(match.key, match);
          else {
            const priorPlayed = prior.actual_time != null || (prior.alliances.red.score >= 0 && prior.alliances.blue.score >= 0);
            const nextPlayed = match.actual_time != null || (match.alliances.red.score >= 0 && match.alliances.blue.score >= 0);
            if (nextPlayed || !priorPlayed) existing.set(match.key, match);
          }
        }
        job.matches = sortMatches([...existing.values()]);
        job.scheduleRefreshedAt = Date.now();
        await writeJob(eventKey, job);
      } catch (error) {
        console.warn("[Insights] event schedule refresh failed", eventKey, error);
      }
    }

    // Keep collected model records paired with the latest TBA match object.
    const latestMatchByKey = new Map(job.matches.map((match) => [match.key, match]));
    for (const [key, record] of Object.entries(job.records)) {
      const latestMatch = latestMatchByKey.get(key);
      if (latestMatch) record.match = latestMatch;
    }

    // Statbotics is acquired once per event, using its event-filtered
    // qualification and elimination collections. Never issue one request per
    // match or refresh automatically as the event progresses.
    if (!job.statboticsLoadedAt) {
      try {
        const [qualificationRecords, eliminationRecords] = await Promise.all([
          Statbotics.getMatches({ event: eventKey, elim: false }, { refresh: forceRefresh }),
          Statbotics.getMatches({ event: eventKey, elim: true }, { refresh: forceRefresh }),
        ]);
        const statboticsByKey = new Map(
          [...qualificationRecords, ...eliminationRecords]
            .filter((record) => typeof record.key === "string")
            .map((record) => [record.key, record]),
        );
        for (const match of job.matches) {
          const statbotics = statboticsByKey.get(match.key) ?? null;
          job.records[match.key] = {
            match,
            statbotics,
            statboticsStatus: statbotics ? "ready" : "unavailable",
          };
        }
        job.statboticsFetchError = null;
      } catch (error) {
        job.statboticsFetchError = error instanceof Error ? error.message : String(error);
        console.warn("[Insights] Statbotics event collection failed", eventKey, error);
        for (const match of job.matches) {
          job.records[match.key] = {
            match,
            statbotics: null,
            statboticsStatus: "unavailable",
          };
        }
      }
      job.statboticsLoadedAt = Date.now();
    }

    const unavailable = Object.values(job.records).some((record) => record.statboticsStatus === "unavailable");
    job.state = unavailable ? "partial" : "complete";
    await writeJob(eventKey, job);
  } catch (error) {
    console.error("[Insights] progressive event analytics worker failed", eventKey, error);
  } finally {
    try {
      await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        lockKey,
        token,
      );
    } catch (error) {
      console.error("[Insights] failed to release progressive analytics lock", eventKey, error);
    }
  }
}
