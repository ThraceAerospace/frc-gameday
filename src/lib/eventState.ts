import { redis } from "./redis";
import { TBA } from "./tbaService";

function key(event: string) {
  return `event:${event}:state`;
}

/**
 * SOURCE OF TRUTH BUILD (used for hydration + webhook refresh)
 */
export async function buildEventState(event: string) {
  const matches = await TBA.getEventMatchesSimple(event);
  const alliances = await TBA.getEventPlayoffAlliances(event);

  const sorted = matches.sort(
    (a: any, b: any) =>
      (a.predicted_time ?? 0) - (b.predicted_time ?? 0)
  );

  const next =
    sorted.find((m: any) => m.actual_time === null) ?? null;

  const last =
    [...sorted].reverse().find((m: any) => m.actual_time !== null) ?? null;

  return {
    event,
    updatedAt: Date.now(),
    matches: sorted,
    nextMatch: next,
    lastMatch: last,
    alliances,
  };
}

/**
 * WRITE
 */
export async function setEventState(event: string, state: any) {
  const key = `state:${event}`;

  await redis.set(key, JSON.stringify(state));
}

/**
 * READ
 */
export async function getEventState(event: string) {
  const key = `state:${event}`;

  const cached = await redis.get(key);

  if (!cached) return null;

  try {
    return JSON.parse(cached);
  } catch (e) {
    console.error("[STATE PARSE ERROR]", e);
    return null;
  }
}

export function computeNextMatch(matches: any[]) {
  const now = Date.now() / 1000;

  return (
    matches
      .filter((m) => m.actual_time === null)
      .map((m) => ({
        ...m,
        predicted_time: m.predicted_time ?? m.time ?? null,
      }))
      .filter((m) => m.predicted_time)
      .sort((a, b) => a.predicted_time - b.predicted_time)[0] ?? null
  );
}