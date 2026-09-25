import { redis } from "@/lib/cache/redis";
import { TBA } from "@/lib/tba/service";
import type { TBAEliminationAlliance, TBAMatchSimple } from "./tba/types";

export type EventState = {
  event: string;
  updatedAt: number;
  nextMatch: TBAMatchSimple | null;
  lastMatch: TBAMatchSimple | null;
  alliances: TBAEliminationAlliance[] | null;
  matches: TBAMatchSimple[];
};

export async function buildEventState(event: string): Promise<EventState> {
  const matches = await TBA.getEventMatchesSimple(event);
  const alliances = await TBA.getEventPlayoffAlliances(event);
  const sorted = [...matches].sort((a, b) => (a.predicted_time ?? 0) - (b.predicted_time ?? 0));
  const next = sorted.find((match) => match.actual_time === null) ?? null;
  const last = [...sorted].reverse().find((match) => match.actual_time !== null) ?? null;
  return { event, updatedAt: Date.now(), nextMatch: next, lastMatch: last, alliances: alliances ?? null, matches: sorted };
}

export async function setEventState(event: string, state: EventState): Promise<void> {
  await redis.set(`state:${event}`, JSON.stringify(state));
}

export async function getEventState(event: string): Promise<EventState | null> {
  const cached = await redis.get(`state:${event}`);
  if (!cached) return null;
  try { return JSON.parse(cached) as EventState; }
  catch (error) { console.error("[STATE PARSE ERROR]", error); return null; }
}

export function computeNextMatch(matches: TBAMatchSimple[]) {
  const now = Date.now() / 1000;
  return matches
    .filter((match) => match.actual_time === null)
    .map((match) => ({ ...match, predicted_time: match.predicted_time ?? match.time ?? null }))
    .filter((match): match is TBAMatchSimple & { predicted_time: number } => match.predicted_time != null && match.predicted_time >= now)
    .sort((a, b) => a.predicted_time - b.predicted_time)[0] ?? null;
}

export async function getAllEventKeys(): Promise<string[]> { return redis.keys("*"); }

export async function getKey(key: string): Promise<unknown> {
  const cached = await redis.get(key);
  if (!cached) return null;
  try { return JSON.parse(cached) as unknown; }
  catch (error) { console.error("[STATE PARSE ERROR]", error); return null; }
}
