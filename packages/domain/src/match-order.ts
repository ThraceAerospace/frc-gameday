/** Minimal TBA match fields required for canonical ordering. */
export interface TbaMatchOrderingFields {
  comp_level: string;
  set_number: number;
  match_number: number;
  actual_time?: number | null;
  predicted_time?: number | null;
  time?: number | null;
}

const COMPETITION_LEVEL_ORDER: Record<string, number> = {
  qm: 0,
  ef: 1,
  qf: 2,
  sf: 3,
  f: 4,
};

function competitionLevelOrder(level: string): number {
  return COMPETITION_LEVEL_ORDER[level.trim().toLowerCase()] ?? 99;
}

/** TBA's competition-order comparison: level, set, then match number. */
export function compareMatches(a: TbaMatchOrderingFields, b: TbaMatchOrderingFields): number {
  const levelDifference =
    competitionLevelOrder(a.comp_level) - competitionLevelOrder(b.comp_level);
  if (levelDifference !== 0) return levelDifference;

  const setDifference = a.set_number - b.set_number;
  if (setDifference !== 0) return setDifference;

  return a.match_number - b.match_number;
}

/**
 * TBA's BestTime behavior: actual, then predicted, then scheduled.
 * A zero/unset epoch is absent; no other fallback is introduced.
 */
export function bestMatchTime(match: TbaMatchOrderingFields): number | undefined {
  for (const candidate of [
    match.actual_time,
    match.predicted_time,
    match.time,
  ]) {
    if (candidate !== undefined && candidate !== null && candidate !== 0) {
      return candidate;
    }
  }
  return undefined;
}

/** Stable TBA competition ordering. Equal matches retain their input order. */
export function sortMatches<T extends TbaMatchOrderingFields>(matches: readonly T[]): T[] {
  return [...matches].sort(compareMatches);
}

/**
 * TBA's chronological ordering: first establish competition order, then
 * stably sort by BestTime. Matches without a usable timestamp sort last.
 * Modern ECMAScript Array#sort is stable (ES2019+).
 */
export function sortMatchesByTime<T extends TbaMatchOrderingFields>(matches: readonly T[]): T[] {
  return sortMatches(matches).sort((a, b) => {
    const aTime = bestMatchTime(a);
    const bTime = bestMatchTime(b);

    if (aTime === undefined && bTime === undefined) return 0;
    if (aTime === undefined) return 1;
    if (bTime === undefined) return -1;
    return aTime - bTime;
  });
}
