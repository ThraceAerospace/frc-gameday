import type { FieldViewEventState } from "../../domain/src/event.ts";
import type { FieldViewMatch } from "../../domain/src/match.ts";
import type { StatboticsMatch } from "@fieldview/provider-statbotics/types";
import type { AnalyticsMatch } from "./types.ts";
import { buildAllianceResults } from "./calculations.ts";
import { buildQualificationAnalysis } from "./calculations.ts";
import { buildMatchFlags } from "./match-flags.ts";
import { createAnalyticsAudit } from "./audit.ts";
import { calculateCanonicalAggregateAnalytics } from "./canonical-aggregate-analytics.ts";
import type { FieldViewAnalyticsInputRecord, FieldViewSeasonCohortSnapshot } from "../../domain/src/analytics.ts";

function epaValues(
  teams: FieldViewMatch["teams"]["red"],
  phase: "pre_epa" | "epa",
): number[] {
  return teams.flatMap((team) => {
    const value = team[phase]?.epa;
    return typeof value === "number" && Number.isFinite(value) ? [value] : [];
  });
}

function allianceTotal(values: number[], expected: number): number | null {
  return values.length === expected
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

function toAnalyticsRecord(match: FieldViewMatch): AnalyticsMatch {
  const pre_epas: NonNullable<StatboticsMatch["pre_epas"]> = {};
  const epas: NonNullable<StatboticsMatch["epas"]> = {};
  for (const team of [...match.teams.red, ...match.teams.blue]) {
    if (team.team_number === undefined) continue;
    const key = String(team.team_number);
    if (team.pre_epa) pre_epas[key] = team.pre_epa;
    if (team.epa) epas[key] = team.epa;
  }
  const prediction = match.predictions.statbotics;
  const hasStatboticsData = Object.keys(pre_epas).length > 0 ||
    Object.keys(epas).length > 0 || prediction !== undefined;
  const statbotics = hasStatboticsData
    ? ({
        key: match.key,
        pre_epas,
        epas,
        ...(prediction === undefined ? {} : { pred: prediction }),
        ...(match.statbotics_week === undefined ? {} : { week: match.statbotics_week }),
        ...(match.statbotics_elim === undefined ? {} : { elim: match.statbotics_elim }),
        ...(match.statbotics_match_name === undefined ? {} : { match_name: match.statbotics_match_name }),
        ...(match.statbotics_status === undefined ? {} : { status: match.statbotics_status }),
        ...(match.statbotics_alliances === undefined ? {} : { alliances: match.statbotics_alliances }),
        ...(match.statbotics_result === undefined ? {} : { result: match.statbotics_result }),
      } as StatboticsMatch)
    : null;
  return {
    match,
    statbotics,
    statboticsStatus: statbotics ? "ready" : "unavailable",
  };
}

/**
 * Calculate canonical match analysis and evidence-bearing flags from the
 * event's normalized provider observations. This runs in EventRuntime and
 * contains no provider I/O. Existing dashboard flag thresholds are reused.
 */
export async function calculateCanonicalMatchAnalytics(
  eventState: FieldViewEventState,
  inputRecords: FieldViewAnalyticsInputRecord[] = [],
  seasonCohort?: FieldViewSeasonCohortSnapshot,
): Promise<FieldViewEventState> {
  if (eventState.matches === undefined || eventState.matches === null) return eventState;

  const records = eventState.matches.map(toAnalyticsRecord);
  const allianceResults = buildAllianceResults(records, eventState.event?.playoff_type);
  const qualificationAnalysis = buildQualificationAnalysis(
    records,
    eventState.matches,
    allianceResults,
    eventState.event?.playoff_type,
  );
  const flagContext = { allianceResults, qualificationAnalysis };
  const audit = await createAnalyticsAudit({
    calculation_id: crypto.randomUUID(),
    calculated_at: Date.now(),
    inputs: inputRecords,
    definition_keys: [
      "alliance-score-residual",
      "alliance-pre-match-epa-total",
      "match-prediction-label",
      "match-model-upset",
      "match-phase-score-anomaly",
      "match-large-score-delta",
      "match-high-alliance-epa",
      "match-high-penalties",
      "qualification-prediction-calibration",
      "qualification-penalty-outliers",
      "team-event-epa",
      "team-epa-contribution-share",
      "team-event-match-appearances",
    ],
    warnings: inputRecords.filter((input) => input.status !== "available")
      .map((input) => `${input.provider}/${input.resource} input is ${input.status}`),
  });
  const resultByMatchAndColor = new Map(
    allianceResults.map((result) => [`${result.matchKey}:${result.color}`, result]),
  );

  const matches = eventState.matches.map((match) => {
    const analysis = (color: "red" | "blue") => {
      const result = resultByMatchAndColor.get(`${match.key}:${color}`);
      const allianceTeams = match.teams[color];
      const preValues = epaValues(allianceTeams, "pre_epa");
      const postValues = epaValues(allianceTeams, "epa");
      return {
        score: {
          actual: match.alliances[color].score,
          ...(result?.predicted === null || result?.predicted === undefined
            ? {}
            : { predicted: result.predicted }),
          ...(result?.residual === null || result?.residual === undefined
            ? {}
            : { delta: result.residual }),
        },
        alliance_epa: {
          pre_match_total: result?.preEpaTotal ?? null,
          post_match_total: allianceTotal(postValues, 3),
          team_count: match.alliances[color].team_keys.length,
          pre_match_team_count: preValues.length,
          post_match_team_count: postValues.length,
          expected_team_count: 3 as const,
        },
      };
    };
    const red = analysis("red");
    const blue = analysis("blue");
    const record = records.find((item) => item.match.key === match.key)!;
    return {
      ...match,
      analysis: {
        score: { red: red.score, blue: blue.score },
        alliance_epa: { red: red.alliance_epa, blue: blue.alliance_epa },
        audit,
      },
      flags: buildMatchFlags(flagContext, record),
    };
  });

  const matchByKey = new Map(matches.map((match) => [match.key, match]));
  const team_states = eventState.team_states === undefined || eventState.team_states === null
    ? eventState.team_states
    : eventState.team_states.map((teamState) => ({
        ...teamState,
        ...(teamState.matches === undefined || teamState.matches === null
          ? {}
          : { matches: teamState.matches.map((match) => matchByKey.get(match.key) ?? match) }),
      }));

  return calculateCanonicalAggregateAnalytics({
    ...eventState,
    matches,
    ...(team_states === undefined ? {} : { team_states }),
  }, records, allianceResults, audit, seasonCohort);
}
