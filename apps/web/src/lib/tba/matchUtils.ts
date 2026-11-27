import { bestMatchTime, sortMatchesByTime, type TbaMatchOrderingFields } from "@fieldview/domain";

/** Minimal shared match shape used by canonical FieldView views. */
export interface MatchLike extends TbaMatchOrderingFields {
  actual_time?: number | null;
  predicted_time?: number | null;
  time?: number | null;
  alliances: {
    red: { score: number | null; team_keys?: string[] | null };
    blue: { score: number | null; team_keys?: string[] | null };
  };
}

export function isPlayed<T extends MatchLike>(match: T) {
  return Boolean(match.actual_time);
}

export function hasPostedScore<T extends MatchLike>(match: T) {
  return (
    match.alliances.red.score != null &&
    match.alliances.red.score >= 0 &&
    match.alliances.blue.score != null &&
    match.alliances.blue.score >= 0
  );
}

export function matchTime(match: MatchLike) {
  return bestMatchTime(match) ?? Infinity;
}

/** Use TBA's stable BestTime ordering for FieldView match views. */
export function sortMatches<T extends MatchLike>(matches: T[]) {
  return sortMatchesByTime(matches);
}

/*
 * A match remains "next" until its score is
 * posted.
 *
 * score === -1 means the match has not been
 * scored yet.
 *
 * Do not use actual_time or score_breakdown
 * here. Those fields can be null even when
 * score data is already available.
 *
 * sortMatches() establishes chronological
 * order, so the first unscored match is the
 * next match.
 */
export function getNextMatch<T extends MatchLike>(
  matches: T[],
) {
  return (
    matches.find(
      (match) =>
        match.alliances.red.score === -1 ||
        match.alliances.blue.score === -1,
    ) ?? null
  );
}

export function getLastMatch<T extends MatchLike>(
  matches: T[],
) {
  return matches.reduce<T | null>(
    (latest, match) => {
      if (!isPlayed(match)) {
        return latest;
      }

      if (
        !latest ||
        (match.actual_time ?? 0) >
          (latest.actual_time ?? 0)
      ) {
        return match;
      }

      return latest;
    },
    null,
  );
}

export function getMatchesForTeams<T extends MatchLike>(
  matches: T[],
  teams: string[],
) {
  if (!teams.length) {
    return matches;
  }

  const wanted = new Set(
    teams.map(String),
  );

  return matches.filter((match) =>
    [
      ...(match.alliances.red.team_keys ??
        []),
      ...(match.alliances.blue.team_keys ??
        []),
    ].some((team) =>
      wanted.has(String(team)),
    ),
  );
}
