import type {
  FieldViewEventTeamComparisonAnalytics,
  FieldViewTeamEventState,
} from "../../domain/src/index.ts";

/**
 * EventRuntime aggregates the individual TeamRuntime comparisons into one
 * event-wide ranking. It does not recalculate any team's season metrics.
 */
export function calculateFieldViewEventTeamComparisonAnalytics(
  teamStates: FieldViewTeamEventState[],
  expectedTeamCount: number,
  sourceRevisions: Array<{ team_key: string; revision: number | null }>,
  inputUpdatedAt: number | null,
): FieldViewEventTeamComparisonAnalytics {
  const ranked = teamStates.flatMap((teamState) => {
    const comparison = teamState.analytics?.season_comparison;
    if (!comparison || !Number.isFinite(comparison.change)) return [];
    return [{
      team_key: teamState.team_key,
      team_number: Number(teamState.team_key.replace(/^frc/i, "")),
      prior_event: comparison.prior_event,
      prior_epa: comparison.prior_epa,
      current_epa: comparison.current_epa,
      change: comparison.change,
      rank: 0,
      population_size: 0,
      components: comparison.components,
    }];
  }).sort((a, b) => b.change - a.change || a.team_number - b.team_number);

  let previousChange: number | null = null;
  let currentRank = 0;
  ranked.forEach((entry, index) => {
    if (previousChange === null || entry.change !== previousChange) currentRank = index + 1;
    entry.rank = currentRank;
    entry.population_size = ranked.length;
    previousChange = entry.change;
  });

  const meanChange = ranked.length
    ? ranked.reduce((sum, entry) => sum + entry.change, 0) / ranked.length
    : null;
  return {
    input_updated_at: inputUpdatedAt,
    population: {
      expected_team_count: expectedTeamCount,
      eligible_team_count: ranked.length,
      excluded_team_count: Math.max(0, expectedTeamCount - ranked.length),
    },
    rankings: ranked,
    largest_change: ranked[0] ?? null,
    smallest_change: ranked.at(-1) ?? null,
    mean_change: meanChange,
    source_revisions: sourceRevisions.map((item) => ({
      team_key: item.team_key as FieldViewEventTeamComparisonAnalytics["source_revisions"][number]["team_key"],
      revision: item.revision,
    })),
  };
}
