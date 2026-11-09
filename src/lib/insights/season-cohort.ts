import { randomUUID } from "node:crypto";
import { redis } from "@/lib/cache/redis";
import { TBA } from "@/lib/tba/service";
import { Statbotics } from "@/lib/statbotics/service";
import type { TBAEvent } from "@/lib/tba/types";
import type { TBAEventSimple } from "@/lib/tba/types";
import type { SeasonCohortRecord, SeasonCohortSnapshot } from "./types";

const TTL_SECONDS = 365 * 24 * 60 * 60;
const LOCK_SECONDS = 45;
const PREFIX = "insights:season-cohort:v1:";
const LOCK_PREFIX = "lock:insights:season-cohort:";
const DISCOVERY_BATCH = 6;
const RECORD_BATCH = 10;
const CONCURRENCY = 2;
const MAX_ATTEMPTS = 1;
const WORK_BUDGET_MS = 22_000;

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
  rosterRefreshedAt?: number;
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
      discoveryQueue: teams.map((team) => team.teamNumber).filter(Number.isFinite),
      discoveryAttempts: {}, recordQueue: [], recordAttempts: {}, records: {},
      discoveryFailures: [], updatedAt: Date.now(), currentEventRefreshedAt: null,
    };
    await writeJob(eventKey, job);
  }
  // Historical Statbotics cohort data is immutable for this prototype.
  // New teams and changed model records are incorporated only on manual refresh.
  return snapshot(job);
}

export async function advanceSeasonCohort(eventKey: string, forceRefresh = false): Promise<void> {
  const lockKey = LOCK_PREFIX + eventKey;
  const token = randomUUID();
  const acquired = await redis.set(lockKey, token, "EX", LOCK_SECONDS, "NX");
  if (acquired !== "OK") return;
  const deadline = Date.now() + WORK_BUDGET_MS;
  try {
    let job = await readJob(eventKey);
    if (!job) return;
    if (forceRefresh) {
      job.discoveryQueue = [...job.teamNumbers];
      job.discoveryAttempts = {};
      job.recordQueue = [];
      job.recordAttempts = {};
      job.records = {};
      job.discoveryFailures = [];
      job.currentEventRefreshedAt = null;
      await writeJob(eventKey, job);
    }
    while (Date.now() < deadline && job.discoveryQueue.length) {
      const batch = job.discoveryQueue.slice(0, DISCOVERY_BATCH);
      await withConcurrency(batch, CONCURRENCY, async (teamNumber) => {
        try {
          const [events, statboticsEvents] = await Promise.all([
            TBA.getTeamEvents("frc" + teamNumber, Number(job.target.key.slice(0, 4))),
            Statbotics.getTeamEvents({ team: teamNumber, year: Number(job.target.key.slice(0, 4)) }, { refresh: forceRefresh }),
          ]);
          const relevant = events.filter((event) =>
            event.event_type !== 99 && event.event_type !== 100 &&
            (event.key === eventKey || event.start_date < job.target.startDate));
          const statboticsByEvent = new Map(statboticsEvents.flatMap((record) =>
            typeof record.event === "string" ? [[record.event, record] as const] : [],
          ));
          for (const event of relevant) {
            const pair: Pair = { teamNumber, event: eventRef(event) };
            const id = pairKey(pair);
            const record = statboticsByEvent.get(event.key) ?? null;
            const totalRecord = record?.record?.total;
            const breakdown = Object.fromEntries(Object.entries(record?.epa?.breakdown ?? {})
              .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
            job.records[id] = {
              teamNumber, event: pair.event, epaTotal: finite(record?.epa?.total_points),
              epaUnitless: finite(record?.epa?.unitless), breakdown,
              wins: finite(totalRecord?.wins), losses: finite(totalRecord?.losses), ties: finite(totalRecord?.ties),
              matches: finite(totalRecord?.count), fetchedAt: Date.now(),
              status: record ? "ready" : "unavailable",
            };
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
    // Discovery already returns the team's complete filtered team_events collection.
    // Persist it directly; no second request per team is needed.
    if (job.currentEventRefreshedAt === null && job.discoveryQueue.length === 0 && !job.recordQueue.some((pair) => pair.event.key === eventKey)) {
      job.currentEventRefreshedAt = Date.now();
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
