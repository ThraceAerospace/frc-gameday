import type { TBAMatch } from "@/lib/tba/types";

export function isPlayed(match: TBAMatch) {
  return Boolean(match.actual_time);
}

export function hasPostedScore(match: TBAMatch) {
  return (
    match.alliances.red.score != null &&
    match.alliances.red.score >= 0 &&
    match.alliances.blue.score != null &&
    match.alliances.blue.score >= 0
  );
}

export function matchTime(
  match: TBAMatch,
) {
  return (
    match.predicted_time ??
    match.time ??
    Infinity
  );
}

export function sortMatches(
  matches: TBAMatch[],
) {
  return [...matches].sort(
    (a, b) =>
      matchTime(a) - matchTime(b),
  );
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
export function getNextMatch(
  matches: TBAMatch[],
) {
  return (
    matches.find(
      (match) =>
        match.alliances.red.score === -1 ||
        match.alliances.blue.score === -1,
    ) ?? null
  );
}

export function getLastMatch(
  matches: TBAMatch[],
) {
  return matches.reduce<TBAMatch | null>(
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

export function getMatchesForTeams(
  matches: TBAMatch[],
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
