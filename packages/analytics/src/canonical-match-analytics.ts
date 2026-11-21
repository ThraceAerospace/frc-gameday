import type { FieldViewEventState } from "../../domain/src/event.ts";
import type { FieldViewTeamEventState } from "../../domain/src/team.ts";
import type { FieldViewMatch } from "../../domain/src/match.ts";
import type { StatboticsMatch } from "@fieldview/provider-statbotics/types";
import type { AnalyticsMatch } from "./types.ts";
import { buildMatchFlagContext } from "./match-flags.ts";
import { createFieldViewAnalyticsEngine } from "./operations.ts";
import { createAnalyticsAudit } from "./audit.ts";
import { calculateCanonicalAggregateAnalytics, calculateCanonicalTeamEventStates } from "./canonical-aggregate-analytics.ts";
import type { FieldViewAnalyticsInputRecord, FieldViewEventTeamSeasonComparisonInput } from "../../domain/src/analytics.ts";
import type { AllianceResult, QualificationAnalysis } from "./types.ts";

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
): Promise<FieldViewEventState> {
  if (eventState.matches === undefined || eventState.matches === null) return eventState;

  const records = eventState.matches.map(toAnalyticsRecord);
  const engine = createFieldViewAnalyticsEngine();
  const allianceExecution = await engine.execute({
    definition_key: "alliance-score-residual",
    context: { records, playoffType: eventState.event?.playoff_type },
    resolved_inputs: {
      "actual-score": eventState.matches.flatMap((match) => [match.alliances.red.score, match.alliances.blue.score].filter((score) => score >= 0)),
      "predicted-score": records.flatMap((record) => [
        record.statbotics?.pred?.red_score,
        record.statbotics?.pred?.blue_score,
      ].filter((score): score is number => typeof score === "number" && Number.isFinite(score))),
    },
  });
  const allianceResults = allianceExecution.value as AllianceResult[];
  const qualificationExecution = await engine.execute({
    definition_key: "qualification-prediction-calibration",
    context: { records, allEventMatches: eventState.matches, allianceResults, playoffType: eventState.event?.playoff_type },
    resolved_inputs: {
      "red-win-probability": records.flatMap((record) => typeof record.statbotics?.pred?.red_win_prob === "number" ? [record.statbotics.pred.red_win_prob] : []),
      winner: records.flatMap((record) => record.match.winning_alliance === "red" || record.match.winning_alliance === "blue" ? [record.match.winning_alliance] : []),
      "score-residuals": allianceResults.flatMap((result) => result.compLevel.toLowerCase() === "qm" && result.residual !== null ? [result.residual] : []),
    },
  });
  const qualificationAnalysis = qualificationExecution.value as QualificationAnalysis;
  const flagContext = { allianceResults, qualificationAnalysis };
  const matchFlagContext = buildMatchFlagContext(flagContext);
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
      "qualification-residual-anomaly",
      "qualification-penalty-outliers",
      "playoff-alliance-performance",
    ],
    warnings: inputRecords.filter((input) => input.status !== "available")
      .map((input) => `${input.provider}/${input.resource} input is ${input.status}`),
  });
  const resultByMatchAndColor = new Map(
    allianceResults.map((result) => [`${result.matchKey}:${result.color}`, result]),
  );

  const matches = await Promise.all(eventState.matches.map(async (match) => {
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
      flags: (await engine.execute({
        definition_key: "match-prediction-label",
        context: { matchFlagData: flagContext, matchRecord: record, matchFlagContext },
        resolved_inputs: {
          "red-win-probability": typeof record.statbotics?.pred?.red_win_prob === "number"
            ? [record.statbotics.pred.red_win_prob] : [],
        },
      })).value,
    };
  }));

  return calculateCanonicalAggregateAnalytics({
    ...eventState,
    matches,
  }, records, allianceResults, audit);
}


/**
 * Calculate one team's event analytics inside TeamRuntime. The supplied event
 * state is a calculation context (all event teams and matches), while only the
 * requested team's TeamEventState is returned and persisted by its owner.
 */
export async function calculateCanonicalTeamEventAnalytics(
  eventState: FieldViewEventState,
  target: FieldViewTeamEventState,
  inputRecords: FieldViewAnalyticsInputRecord[] = [],
  comparisonInput?: FieldViewEventTeamSeasonComparisonInput,
): Promise<FieldViewTeamEventState> {
  if (!eventState.matches) return target;

  const records = eventState.matches.map(toAnalyticsRecord);
  const engine = createFieldViewAnalyticsEngine();
  const allianceResults = (await engine.execute({
    definition_key: "alliance-score-residual",
    context: { records, playoffType: eventState.event?.playoff_type },
    resolved_inputs: {
      "actual-score": eventState.matches.flatMap((match) => [match.alliances.red.score, match.alliances.blue.score].filter((score) => score >= 0)),
      "predicted-score": records.flatMap((record) => [
        record.statbotics?.pred?.red_score,
        record.statbotics?.pred?.blue_score,
      ].filter((score): score is number => typeof score === "number" && Number.isFinite(score))),
    },
  })).value as AllianceResult[];
  const audit = await createAnalyticsAudit({
    calculation_id: crypto.randomUUID(),
    calculated_at: Date.now(),
    inputs: inputRecords,
    definition_keys: [
      "team-season-event-comparison",
      "team-event-epa",
      "team-epa-contribution-share",
      "team-event-match-appearances",
      "team-event-investigation",
    ],
    warnings: inputRecords.filter((input) => input.status !== "available")
      .map((input) => `${input.provider}/${input.resource} input is ${input.status}`),
  });
  const calculated = await calculateCanonicalTeamEventStates(
    eventState,
    [target],
    records,
    allianceResults,
    audit,
    comparisonInput,
  );
  return calculated[0] ?? target;
}
