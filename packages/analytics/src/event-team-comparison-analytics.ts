import type {
  FieldViewAnalyticsTeamSummary,
  FieldViewEventState,
  FieldViewEventTeamComparisonAnalytics,
  FieldViewTeamEventState,
  TeamKey,
} from "../../domain/src/index.ts";

/**
 * EventRuntime aggregates the individual TeamRuntime comparisons into one
 * event-wide ranking. It does not recalculate any team's season metrics.
 */
export function calculateFieldViewEventTeamComparisonAnalytics(
  teamStates: FieldViewTeamEventState[],
  expectedTeamCount: number,
  teamStateRevisions: Array<{ team_key: string; revision: number | null }>,
  teamEventStateRevisions: Array<{ team_key: string; revision: number | null }>,
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
    team_state_revisions: teamStateRevisions.map((item) => ({ team_key: item.team_key as TeamKey, revision: item.revision })),
    team_event_state_revisions: teamEventStateRevisions.map((item) => ({ team_key: item.team_key as TeamKey, revision: item.revision })),
  };
}


/**
 * Build the event's team comparison table only from TeamRuntime-owned
 * TeamEventState analytics. EventRuntime contributes provider-owned event OPR
 * values and display identity, but does not recalculate team EPA metrics.
 */
export function buildFieldViewEventTeamSummaries(
  eventState: Pick<FieldViewEventState, "teams" | "event_teams">,
  teamStates: FieldViewTeamEventState[],
): FieldViewAnalyticsTeamSummary[] {
  const teams = new Map((eventState.teams ?? []).map((team) => [team.key, team]));
  const eventTeams = new Map((eventState.event_teams ?? []).map((team) => [team.team_key, team]));
  return teamStates.flatMap((teamState) => {
    const team = teams.get(teamState.team_key);
    const analytics = teamState.analytics;
    if (!team || !analytics) return [];
    const performance = analytics.performance;
    const contribution = analytics.metrics.find((item) => item.metric_key === "epa-contribution-percent");
    return [{
      team_key: teamState.team_key,
      team_number: team.team_number,
      name: team.nickname || team.name || `Team ${team.team_number}`,
      opr: eventTeams.get(teamState.team_key)?.opr ?? null,
      dpr: eventTeams.get(teamState.team_key)?.dpr ?? null,
      ccwm: eventTeams.get(teamState.team_key)?.ccwm ?? null,
      epa: performance?.epa ?? null,
      auto_epa: performance?.auto_epa ?? null,
      teleop_epa: performance?.teleop_epa ?? null,
      endgame_epa: performance?.endgame_epa ?? null,
      matches_seen: performance?.matches_seen ?? 0,
      epa_percentile: performance?.epa_percentile ?? null,
      epa_contribution_percent: contribution?.status === "available" ? contribution.value : null,
      epa_contribution_samples: contribution?.sample_size ?? 0,
    }];
  });
}
