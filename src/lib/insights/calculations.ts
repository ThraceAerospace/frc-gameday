import type { StatboticsEPA } from "@/lib/statbotics/types";
import type { TBAMatch } from "@/lib/tba/types";
import type { AllianceResult, AnalyticsMatch, ReviewFinding, TeamAnalyticsRow, TeamEpaPoint } from "./types";

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function teamNumber(teamKey: string): number {
  return Number(teamKey.replace(/^frc/i, ""));
}

function statboticsTeamKey(teamKey: string): string {
  return String(teamNumber(teamKey));
}

function matchLabel(match: TBAMatch): string {
  const level = match.comp_level.toUpperCase();
  return match.comp_level === "qm"
    ? `QM ${match.match_number}`
    : `${level} ${match.set_number} · ${match.match_number}`;
}

function epaFor(
  match: AnalyticsMatch,
  teamKey: string,
  phase: "pre_epas" | "epas",
): StatboticsEPA | undefined {
  return match.statbotics?.[phase]?.[statboticsTeamKey(teamKey)];
}

function percentile(values: number[], value: number): number | null {
  if (!values.length) return null;
  const belowOrEqual = values.filter((candidate) => candidate <= value).length;
  return values.length === 1 ? 1 : (belowOrEqual - 1) / (values.length - 1);
}

export function buildAllianceResults(records: AnalyticsMatch[]): AllianceResult[] {
  const results: AllianceResult[] = [];
  for (const record of records) {
    const { match, statbotics } = record;
    for (const color of ["red", "blue"] as const) {
      const alliance = match.alliances[color];
      const predicted = numberOrNull(
        color === "red" ? statbotics?.pred?.red_score : statbotics?.pred?.blue_score,
      );
      const actual = numberOrNull(alliance.score);
      const teamKeys = alliance.team_keys ?? [];
      const teamEpas = teamKeys.map((key) => numberOrNull(epaFor(record, key, "pre_epas")?.epa));
      const preEpaTotal = teamEpas.every((value) => value !== null)
        ? teamEpas.reduce<number>((sum, value) => sum + (value ?? 0), 0)
        : null;
      const residual = actual !== null && actual >= 0 && predicted !== null
        ? actual - predicted
        : null;
      results.push({
        matchKey: match.key,
        matchLabel: matchLabel(match),
        compLevel: match.comp_level,
        color,
        teamKeys,
        predicted,
        actual: actual !== null && actual >= 0 ? actual : null,
        residual,
        preEpaTotal,
        winner: match.winning_alliance === color,
      });
    }
  }
  return results;
}

export function buildTeamRows(
  teams: { key: string; team_number: number; nickname?: string | null; name?: string | null }[],
  oprs: { oprs?: Record<string, number>; dprs?: Record<string, number>; ccwms?: Record<string, number> } | null,
  records: AnalyticsMatch[],
): TeamAnalyticsRow[] {
  const latest = new Map<string, { pre?: StatboticsEPA; matchesSeen: number }>();
  for (const record of records) {
    for (const teamKey of [
      ...(record.match.alliances.red.team_keys ?? []),
      ...(record.match.alliances.blue.team_keys ?? []),
    ]) {
      const key = statboticsTeamKey(teamKey);
      const existing = latest.get(key);
      latest.set(key, {
        pre: epaFor(record, teamKey, "pre_epas") ?? existing?.pre,
        matchesSeen: (existing?.matchesSeen ?? 0) + 1,
      });
    }
  }

  const rows = teams.map((team) => {
    const key = statboticsTeamKey(team.key);
    const current = latest.get(key);
    const epa = current?.pre;
    return {
      teamKey: team.key,
      teamNumber: team.team_number,
      name: team.nickname || team.name || `Team ${team.team_number}`,
      opr: numberOrNull(oprs?.oprs?.[team.key]),
      dpr: numberOrNull(oprs?.dprs?.[team.key]),
      ccwm: numberOrNull(oprs?.ccwms?.[team.key]),
      epa: numberOrNull(epa?.epa),
      autoEpa: numberOrNull(epa?.auto_epa),
      teleopEpa: numberOrNull(epa?.teleop_epa),
      endgameEpa: numberOrNull(epa?.endgame_epa),
      matchesSeen: current?.matchesSeen ?? 0,
      epaPercentile: null,
      oprPercentile: null,
    };
  });

  const epaValues = rows.flatMap((row) => row.epa === null ? [] : [row.epa]);
  const oprValues = rows.flatMap((row) => row.opr === null ? [] : [row.opr]);
  return rows.map((row) => ({
    ...row,
    epaPercentile: row.epa === null ? null : percentile(epaValues, row.epa),
    oprPercentile: row.opr === null ? null : percentile(oprValues, row.opr),
  }));
}

export function buildTeamEpaHistory(records: AnalyticsMatch[], teamKey: string): TeamEpaPoint[] {
  return records
    .filter((record) => (record.match.alliances.red.team_keys ?? []).includes(teamKey) ||
      (record.match.alliances.blue.team_keys ?? []).includes(teamKey))
    .map((record) => {
      const pre = numberOrNull(epaFor(record, teamKey, "pre_epas")?.epa);
      const post = numberOrNull(epaFor(record, teamKey, "epas")?.epa);
      return pre === null || post === null ? null : {
        matchKey: record.match.key,
        matchLabel: matchLabel(record.match),
        preEpa: pre,
        postEpa: post,
      };
    })
    .filter((point): point is TeamEpaPoint => point !== null);
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function confidence(sampleSize: number): ReviewFinding["confidence"] {
  return sampleSize >= 12 ? "high" : sampleSize >= 6 ? "medium" : "low";
}

export function buildReviewFindings(
  records: AnalyticsMatch[],
  allianceResults: AllianceResult[],
  teamRows: TeamAnalyticsRow[],
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const residuals = allianceResults.flatMap((result) => result.residual === null ? [] : [result.residual]);
  const deviation = standardDeviation(residuals);
  const residualThreshold = Math.max(25, deviation * 1.5);

  if (residuals.length >= 4) {
    for (const result of allianceResults) {
      if (result.residual === null || Math.abs(result.residual) < residualThreshold) continue;
      findings.push({
        id: `residual:${result.matchKey}:${result.color}`,
        category: "score-residual",
        subject: `${result.matchLabel} · ${result.color} alliance`,
        title: result.residual > 0 ? "Alliance scored well above prediction" : "Alliance scored well below prediction",
        description: `The alliance's actual score differed from its Statbotics prediction by ${Math.round(result.residual)} points.`,
        evidence: [`Predicted ${Math.round(result.predicted ?? 0)} · actual ${result.actual}`, `Event residual standard deviation: ${deviation.toFixed(1)} points`],
        sampleSize: residuals.length,
        confidence: confidence(residuals.length),
        suggestedAction: "Review the match and its webcast. The residual is alliance-level and does not identify which robot caused the difference.",
        severity: Math.abs(result.residual) >= residualThreshold * 2 ? "high" : "medium",
      });
    }
  }

  for (const row of teamRows) {
    if (row.epaPercentile === null || row.oprPercentile === null) continue;
    const difference = Math.abs(row.epaPercentile - row.oprPercentile);
    if (difference < 0.25) continue;
    findings.push({
      id: `models:${row.teamNumber}`,
      category: "model-disagreement",
      subject: `Team ${row.teamNumber}`,
      title: "EPA and OPR rank this team differently",
      description: `The team's event-relative EPA and OPR percentiles differ by ${Math.round(difference * 100)} percentile points.`,
      evidence: [`EPA percentile: ${Math.round(row.epaPercentile * 100)}`, `OPR percentile: ${Math.round(row.oprPercentile * 100)}`],
      sampleSize: row.matchesSeen,
      confidence: confidence(row.matchesSeen),
      suggestedAction: "Compare the team's match history and alliance context. The two models estimate different things and use different methods.",
      severity: difference >= 0.45 ? "high" : "medium",
    });
  }

  for (const record of records) {
    const red = record.match.alliances.red.team_keys ?? [];
    const blue = record.match.alliances.blue.team_keys ?? [];
    const redUpdates = red.map((key) => {
      const before = numberOrNull(epaFor(record, key, "pre_epas")?.epa);
      const after = numberOrNull(epaFor(record, key, "epas")?.epa);
      return before === null || after === null ? null : after - before;
    }).filter((value): value is number => value !== null);
    const blueUpdates = blue.map((key) => {
      const before = numberOrNull(epaFor(record, key, "pre_epas")?.epa);
      const after = numberOrNull(epaFor(record, key, "epas")?.epa);
      return before === null || after === null ? null : after - before;
    }).filter((value): value is number => value !== null);
    for (const [color, updates] of [["red", redUpdates], ["blue", blueUpdates]] as const) {
      if (updates.length < 2) continue;
      const shared = updates.every((value) => Math.abs(value - updates[0]) < 0.02);
      if (!shared || Math.abs(updates[0]) < 10) continue;
      const teams = color === "red" ? red : blue;
      findings.push({
        id: `update:${record.match.key}:${color}`,
        category: "rating-update",
        subject: `${matchLabel(record.match)} · ${color} alliance`,
        title: "Large shared EPA model update",
        description: `The model applied approximately ${updates[0] > 0 ? "+" : ""}${updates[0].toFixed(1)} EPA to each available team estimate in this alliance.`,
        evidence: [`Teams: ${teams.map((key) => key.replace(/^frc/i, "")).join(", ")}`, "These are shared model updates, not independently observed robot contributions."],
        sampleSize: 1,
        confidence: "low",
        suggestedAction: "Review the alliance's match result and score breakdown. Do not attribute this update to an individual robot.",
        severity: Math.abs(updates[0]) >= 20 ? "high" : "medium",
      });
    }
  }

  const combinations = new Map<string, AllianceResult[]>();
  for (const result of allianceResults) {
    if (result.residual === null || result.teamKeys.length !== 3) continue;
    const key = [...result.teamKeys].sort().join("-");
    combinations.set(key, [...(combinations.get(key) ?? []), result]);
  }
  for (const [key, results] of combinations) {
    if (results.length < 2) continue;
    const mean = results.reduce((sum, result) => sum + (result.residual ?? 0), 0) / results.length;
    if (Math.abs(mean) < 20) continue;
    findings.push({
      id: `alliance:${key}`,
      category: "alliance-pattern",
      subject: `Alliance ${key.split("-").map((team) => team.replace(/^frc/i, "")).join(" · ")}`,
      title: mean > 0 ? "Repeated positive alliance residuals" : "Repeated negative alliance residuals",
      description: `This exact three-team combination averaged ${mean > 0 ? "+" : ""}${mean.toFixed(1)} points relative to prediction across its matches.`,
      evidence: results.map((result) => `${result.matchLabel}: ${result.residual?.toFixed(1)} points`),
      sampleSize: results.length,
      confidence: confidence(results.length),
      suggestedAction: "Review the repeated matchups and partner context. This describes the alliance combination, not an individual team's contribution.",
      severity: results.length >= 3 && Math.abs(mean) >= 35 ? "high" : "low",
    });
  }

  return findings.sort((a, b) => {
    const severity = { high: 3, medium: 2, low: 1 };
    return severity[b.severity] - severity[a.severity] || b.sampleSize - a.sampleSize;
  });
}

export function compareAllianceTeams(match: TBAMatch, color: "red" | "blue"): string[] {
  return match.alliances[color].team_keys ?? [];
}
