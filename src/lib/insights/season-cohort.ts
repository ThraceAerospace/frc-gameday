import { randomUUID } from "node:crypto";
import { redis } from "@/lib/cache/redis";
import { TBA } from "@/lib/tba/service";
import { Statbotics } from "@/lib/statbotics/service";
import type { TBAEvent } from "@/lib/tba/types";
import type { TBAEventSimple } from "@/lib/tba/types";
import type { SeasonCohortRecord, SeasonCohortSnapshot } from "./types";

const TTL_SECONDS = 24 * 60 * 60;
const LOCK_SECONDS = 45;
const PREFIX = "insights:season-cohort:v1:";
const LOCK_PREFIX = "lock:insights:season-cohort:";
const DISCOVERY_BATCH = 8;
const RECORD_BATCH = 10;
const CONCURRENCY = 2;
const MAX_ATTEMPTS = 2;
const WORK_BUDGET_MS = 22_000;
const CURRENT_EVENT_REFRESH_MS = 10 * 60 * 1000;

type EventRef = { key: string; name: string; shortName: string; startDate: string };
type Pair = { teamNumber: number; event: EventRef };
type Job = {
  target: EventRef;
  teamNumbers: number[];
  discoveryQueue: number[];
  discoveryAttempts: Record<string, number>;
  recordQueue: Pair[];
  recordAttempts: Record<string, number>;
  records: Record<string, SeasonCohortRecord>;
  discoveryFailures: number[];
  updatedAt: number;
  currentEventRefreshedAt: number | null;
};

function key(eventKey: string) { return PREFIX + eventKey; }
function pairKey(pair: Pair) { return pair.teamNumber + ":" + pair.event.key; }
function eventRef(event: TBAEventSimple): EventRef {
  return { key: event.key, name: event.name, shortName: event.event_code, startDate: event.start_date };
}
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
async function readJob(eventKey: string): Promise<Job | null> {
  const raw = await redis.get(key(eventKey));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Job;
    if (!value.target || !Array.isArray(value.teamNumbers) || !Array.isArray(value.discoveryQueue) ||
      !Array.isArray(value.recordQueue) || !value.records) {
      await redis.del(key(eventKey));
      return null;
    }
    return value;
  } catch {
    await redis.del(key(eventKey));
    return null;
  }
}
async function writeJob(eventKey: string, job: Job) {
  job.updatedAt = Date.now();
  await redis.set(key(eventKey), JSON.stringify(job), "EX", TTL_SECONDS);
}
async function withConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) await worker(items[cursor++]);
  }));
}
function state(job: Job): SeasonCohortSnapshot["state"] {
  if (job.discoveryQueue.length) return "discovering";
  if (job.recordQueue.length) return "collecting";
  return job.discoveryFailures.length || Object.values(job.records).some((record) => record.status === "unavailable")
    ? "partial" : "complete";
}
function snapshot(job: Job): SeasonCohortSnapshot {
  const records = Object.values(job.records).sort((a, b) =>
    a.teamNumber - b.teamNumber || a.event.startDate.localeCompare(b.event.startDate));
  return {
    state: state(job), teamCount: job.teamNumbers.length,
    totalTeamEventRecords: records.length + job.recordQueue.length,
    processedTeamEventRecords: records.length,
    unavailableTeamEventRecords: records.filter((record) => record.status === "unavailable").length + job.discoveryFailures.length,
    discoveryPendingTeams: job.discoveryQueue.length,
    updatedAt: job.updatedAt, records,
  };
}

export async function getSeasonCohortSnapshot(event: TBAEvent, teams: { teamNumber: number }[]): Promise<SeasonCohortSnapshot> {
  const eventKey = event.key;
  let job = await readJob(eventKey);
  if (!job) {
    job = {
      target: { key: event.key, name: event.name, shortName: event.event_code, startDate: event.start_date },
      teamNumbers: teams.map((team) => team.teamNumber).filter(Number.isFinite),
      discoveryQueue: teams.map((team) => team.team_number).filter(Number.isFinite),
      discoveryAttempts: {}, recordQueue: [], recordAttempts: {}, records: {},
      discoveryFailures: [], updatedAt: Date.now(), currentEventRefreshedAt: null,
    };
    await writeJob(eventKey, job);
  }
  // The current event's Statbotics team-event record evolves as the event progresses.
  if ((job.currentEventRefreshedAt === null || Date.now() - job.currentEventRefreshedAt > CURRENT_EVENT_REFRESH_MS) &&
      job.discoveryQueue.length === 0 && job.recordQueue.length === 0) {
    for (const teamNumber of job.teamNumbers) {
      const id = teamNumber + ":" + eventKey;
      delete job.records[id];
      delete job.recordAttempts[id];
      job.recordQueue.push({ teamNumber, event: job.target });
    }
    job.currentEventRefreshedAt = Date.now();
    await writeJob(eventKey, job);
  }
  return snapshot(job);
}

export async function advanceSeasonCohort(eventKey: string): Promise<void> {
  const lockKey = LOCK_PREFIX + eventKey;
  const token = randomUUID();
  const acquired = await redis.set(lockKey, token, "EX", LOCK_SECONDS, "NX");
  if (acquired !== "OK") return;
  const deadline = Date.now() + WORK_BUDGET_MS;
  try {
    const job = await readJob(eventKey);
    if (!job) return;
    while (Date.now() < deadline && job.discoveryQueue.length) {
      const batch = job.discoveryQueue.slice(0, DISCOVERY_BATCH);
      await withConcurrency(batch, CONCURRENCY, async (teamNumber) => {
        try {
          const events = await TBA.getTeamEvents("frc" + teamNumber, Number(job.target.key.slice(0, 4)));
          const relevant = events.filter((event) =>
            event.event_type !== 99 && event.event_type !== 100 &&
            (event.key === eventKey || event.start_date < job.target.startDate));
          for (const event of relevant) {
            const pair: Pair = { teamNumber, event: eventRef(event) };
            const id = pairKey(pair);
            if (!job.records[id] && !job.recordQueue.some((item) => pairKey(item) === id)) job.recordQueue.push(pair);
          }
          job.discoveryQueue = job.discoveryQueue.filter((value) => value !== teamNumber);
        } catch {
          const attempts = (job.discoveryAttempts[String(teamNumber)] ?? 0) + 1;
          job.discoveryAttempts[String(teamNumber)] = attempts;
          if (attempts >= MAX_ATTEMPTS) {
            job.discoveryQueue = job.discoveryQueue.filter((value) => value !== teamNumber);
            job.discoveryFailures.push(teamNumber);
          }
        }
      });
      await writeJob(eventKey, job);
    }
    while (Date.now() < deadline && job.discoveryQueue.length === 0 && job.recordQueue.length) {
      const batch = job.recordQueue.slice(0, RECORD_BATCH);
      await withConcurrency(batch, CONCURRENCY, async (pair) => {
        const id = pairKey(pair);
        try {
          const record = await Statbotics.getTeamEvent(pair.teamNumber, pair.event.key, { refresh: pair.event.key === eventKey });
          const total = finite(record?.epa?.total_points);
          const breakdown = Object.fromEntries(Object.entries(record?.epa?.breakdown ?? {})
            .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
          const totalRecord = record?.record?.total;
          job.records[id] = {
            teamNumber: pair.teamNumber, event: pair.event, epaTotal: total,
            epaUnitless: finite(record?.epa?.unitless), breakdown,
            wins: finite(totalRecord?.wins), losses: finite(totalRecord?.losses), ties: finite(totalRecord?.ties),
            matches: finite(totalRecord?.count), fetchedAt: Date.now(),
            status: record ? "ready" : "unavailable",
          };
          job.recordQueue = job.recordQueue.filter((item) => pairKey(item) !== id);
        } catch {
          const attempts = (job.recordAttempts[id] ?? 0) + 1;
          job.recordAttempts[id] = attempts;
          if (attempts >= MAX_ATTEMPTS) {
            job.records[id] = { teamNumber: pair.teamNumber, event: pair.event, epaTotal: null,
              epaUnitless: null, breakdown: {}, wins: null, losses: null, ties: null, matches: null,
              fetchedAt: Date.now(), status: "unavailable" };
            job.recordQueue = job.recordQueue.filter((item) => pairKey(item) !== id);
          }
        }
      });
      await writeJob(eventKey, job);
    }
    await writeJob(eventKey, job);
  } catch (error) {
    console.error("[Insights] season cohort collection failed", eventKey, error);
  } finally {
    try {
      await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, token);
    } catch (error) {
      console.error("[Insights] failed to release season cohort lock", eventKey, error);
    }
  }
}
