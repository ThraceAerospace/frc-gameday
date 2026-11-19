/**
 * Explicit source-to-calculation dependencies for canonical event analytics.
 *
 * Match calculations currently share event-wide baselines, residual
 * distributions, and aggregate inputs. Match keys are retained as invalidation
 * hints, but publication remains a full-event calculation until those shared
 * dependencies can be incrementally maintained without changing semantics.
 */
export type AnalyticsSourceKey =
  | "tba-event"
  | "tba-event-teams"
  | "tba-team-event-statuses"
  | "tba-event-matches"
  | "tba-event-alliances"
  | "tba-event-oprs"
  | "tba-event-predictions"
  | "statbotics-event-matches"
  | "season-cohort"
  | "manual";

export type AnalyticsInvalidationScope =
  | "match-analysis"
  | "event-aggregate"
  | "team-aggregate"
  | "playoff-aggregate"
  | "season-comparison";

export interface AnalyticsInvalidation {
  sources: AnalyticsSourceKey[];
  scopes: AnalyticsInvalidationScope[];
  /** null means the entire match collection may be affected. */
  match_keys: string[] | null;
  /** Current analytics calculations have event-wide dependencies. */
  full_event_recalculation: true;
  requested_at: number;
}

const SOURCE_SCOPES: Record<AnalyticsSourceKey, AnalyticsInvalidationScope[]> = {
  "tba-event": ["match-analysis", "event-aggregate", "team-aggregate", "playoff-aggregate"],
  "tba-event-teams": ["team-aggregate"],
  "tba-team-event-statuses": ["team-aggregate"],
  "tba-event-matches": ["match-analysis", "event-aggregate", "team-aggregate", "playoff-aggregate"],
  "tba-event-alliances": ["playoff-aggregate"],
  "tba-event-oprs": ["team-aggregate"],
  "tba-event-predictions": ["match-analysis", "event-aggregate", "team-aggregate"],
  "statbotics-event-matches": ["match-analysis", "event-aggregate", "team-aggregate"],
  "season-cohort": ["team-aggregate", "season-comparison"],
  "manual": ["match-analysis", "event-aggregate", "team-aggregate", "playoff-aggregate", "season-comparison"],
};

export function planAnalyticsInvalidation(
  source: AnalyticsSourceKey,
  matchKeys: readonly string[] | null = null,
  requestedAt = Date.now(),
): AnalyticsInvalidation {
  const normalizedKeys = matchKeys === null
    ? null
    : [...new Set(matchKeys.filter((key) => key.length > 0))].sort();
  return {
    sources: [source],
    scopes: [...SOURCE_SCOPES[source]],
    match_keys: normalizedKeys,
    full_event_recalculation: true,
    requested_at: requestedAt,
  };
}

/** Merge overlapping source changes into one durable pending invalidation. */
export function mergeAnalyticsInvalidations(
  current: AnalyticsInvalidation | null | undefined,
  next: AnalyticsInvalidation,
): AnalyticsInvalidation {
  if (!current) return next;
  const matchKeys = current.match_keys === null || next.match_keys === null
    ? null
    : [...new Set([...current.match_keys, ...next.match_keys])].sort();
  return {
    sources: [...new Set([...current.sources, ...next.sources])].sort(),
    scopes: [...new Set([...current.scopes, ...next.scopes])].sort(),
    match_keys: matchKeys,
    full_event_recalculation: true,
    requested_at: Math.min(current.requested_at, next.requested_at),
  };
}
