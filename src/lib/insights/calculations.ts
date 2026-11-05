import type { StatboticsEPA } from "@/lib/statbotics/types";
import type { AllianceResult, AnalyticsMatch, ReviewFinding, TeamAnalyticsRow } from "./types";

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function statboticsTeamKey(teamKey: string): string {
  return String(Number(teamKey.replace(/^frc/i, "")));
}
function matchLabel(match: AnalyticsMatch["match"]): string {
  return match.comp_level === "qm" ? `QM ${match.match_number}` : `${match.comp_level.toUpperCase()} ${match.set_number} · ${match.match_number}`;
}
function epaFor(record: AnalyticsMatch, teamKey: string, phase: "pre_epas" | "epas"): StatboticsEPA | undefined {
  return record.statbotics?.[phase]?.[statboticsTeamKey(teamKey)];
}
function percentile(values: number[], value: number): number | null {
  if (!values.length) return null;
  const belowOrEqual = values.filter((candidate) => candidate <= value).length;
  return values.length === 1 ? 1 : (belowOrEqual - 1) / (values.length - 1);
}
export function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
export function standardDeviation(values: number[]): number | null {
  if (!values.length) return null;
  const average = mean(values) ?? 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}
export function buildAllianceResults(records: AnalyticsMatch[]): AllianceResult[] {
  return records.flatMap(({ match, statbotics }) => (["red", "blue"] as const).map((color) => {
    const alliance = match.alliances[color];
    const predicted = numberOrNull(color === "red" ? statbotics?.pred?.red_score : statbotics?.pred?.blue_score);
    const rawActual = numberOrNull(alliance.score);
    const actual = rawActual !== null && rawActual >= 0 ? rawActual : null;
    const teamKeys = alliance.team_keys ?? [];
    const values = teamKeys.map((key) => numberOrNull(statbotics?.pre_epas?.[statboticsTeamKey(key)]?.epa));
    const preEpaTotal = values.every((value) => value !== null) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
    return { matchKey: match.key, matchLabel: matchLabel(match), compLevel: match.comp_level, color, teamKeys, predicted, actual, residual: actual !== null && predicted !== null ? actual - predicted : null, preEpaTotal, winner: match.winning_alliance === color };
  }));
}
export function buildTeamRows(
  teams: { key: string; team_number: number; nickname?: string | null; name?: string | null }[],
  oprs: { oprs?: Record<string, number>; dprs?: Record<string, number>; ccwms?: Record<string, number> } | null,
  records: AnalyticsMatch[],
  allianceResults: AllianceResult[],
): TeamAnalyticsRow[] {
  const latest = new Map<string, { epa?: StatboticsEPA; matchesSeen: number }>();
  for (const record of records) {
    for (const key of [...(record.match.alliances.red.team_keys ?? []), ...(record.match.alliances.blue.team_keys ?? [])]) {
      const id = statboticsTeamKey(key);
      const previous = latest.get(id);
      latest.set(id, { epa: epaFor(record, key, "epas") ?? epaFor(record, key, "pre_epas") ?? previous?.epa, matchesSeen: (previous?.matchesSeen ?? 0) + 1 });
    }
  }
  const rows = teams.map((team) => {
    const current = latest.get(String(team.team_number));
    const residuals = allianceResults.filter((item) => item.teamKeys.includes(team.key) && item.residual !== null).map((item) => item.residual as number);
    return {
      teamKey: team.key, teamNumber: team.team_number, name: team.nickname || team.name || `Team ${team.team_number}`,
      opr: numberOrNull(oprs?.oprs?.[team.key]), dpr: numberOrNull(oprs?.dprs?.[team.key]), ccwm: numberOrNull(oprs?.ccwms?.[team.key]),
      epa: numberOrNull(current?.epa?.epa), autoEpa: numberOrNull(current?.epa?.auto_epa), teleopEpa: numberOrNull(current?.epa?.teleop_epa), endgameEpa: numberOrNull(current?.epa?.endgame_epa),
      matchesSeen: current?.matchesSeen ?? 0, epaPercentile: null as number | null, oprPercentile: null as number | null,
      allianceResidualMean: mean(residuals), allianceResidualSpread: standardDeviation(residuals),
    };
  });
  const epaValues = rows.flatMap((row) => row.epa === null ? [] : [row.epa]);
  const oprValues = rows.flatMap((row) => row.opr === null ? [] : [row.opr]);
  return rows.map((row) => ({ ...row, epaPercentile: row.epa === null ? null : percentile(epaValues, row.epa), oprPercentile: row.opr === null ? null : percentile(oprValues, row.opr) }));
}
function confidence(n: number): ReviewFinding["confidence"] { return n >= 12 ? "high" : n >= 6 ? "medium" : "low"; }
export function buildReviewFindings(records: AnalyticsMatch[], allianceResults: AllianceResult[], teams: TeamAnalyticsRow[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const residuals = allianceResults.flatMap((item) => item.residual === null ? [] : [item.residual]);
  const spread = standardDeviation(residuals) ?? 0;
  const threshold = Math.max(25, spread * 1.5);
  if (residuals.length >= 4) for (const item of allianceResults) {
    if (item.residual === null || Math.abs(item.residual) < threshold) continue;
    findings.push({ id: `residual:${item.matchKey}:${item.color}`, category: "score-residual", subject: `${item.matchLabel} · ${item.color} alliance`, title: item.residual > 0 ? "Alliance scored well above prediction" : "Alliance scored well below prediction", description: `Actual alliance score differed from prediction by ${Math.round(item.residual)} points.`, evidence: [`Predicted ${Math.round(item.predicted ?? 0)} · actual ${item.actual}`, `Sample residual SD: ${spread.toFixed(1)} points`], sampleSize: residuals.length, confidence: confidence(residuals.length), suggestedAction: "Review the match and webcast. This is an alliance-level result, not an attribution to a robot.", severity: Math.abs(item.residual) >= threshold * 2 ? "high" : "medium" });
  }
  for (const team of teams) {
    if (team.epaPercentile === null || team.oprPercentile === null) continue;
    const difference = Math.abs(team.epaPercentile - team.oprPercentile);
    if (difference < 0.25) continue;
    findings.push({ id: `models:${team.teamNumber}`, category: "model-disagreement", subject: `Team ${team.teamNumber}`, title: "EPA and OPR rank this team differently", description: `Event-relative EPA and OPR percentiles differ by ${Math.round(difference * 100)} percentile points.`, evidence: [`EPA percentile: ${Math.round(team.epaPercentile * 100)}`, `OPR percentile: ${Math.round(team.oprPercentile * 100)}`], sampleSize: team.matchesSeen, confidence: confidence(team.matchesSeen), suggestedAction: "Review match history and alliance context. These are different models, not interchangeable measurements.", severity: difference >= 0.45 ? "high" : "medium" });
  }
  for (const record of records) for (const color of ["red", "blue"] as const) {
    const keys = record.match.alliances[color].team_keys ?? [];
    const updates = keys.map((key) => {
      const before = numberOrNull(epaFor(record, key, "pre_epas")?.epa);
      const after = numberOrNull(epaFor(record, key, "epas")?.epa);
      return before === null || after === null ? null : after - before;
    }).filter((value): value is number => value !== null);
    if (updates.length < 2 || !updates.every((value) => Math.abs(value - updates[0]) < 0.02) || Math.abs(updates[0]) < 10) continue;
    findings.push({ id: `update:${record.match.key}:${color}`, category: "rating-update", subject: `${matchLabel(record)} · ${color} alliance`, title: "Large shared EPA model update", description: `The model applied approximately ${updates[0] > 0 ? "+" : ""}${updates[0].toFixed(1)} EPA to each available team estimate.`, evidence: [`Teams: ${keys.map((key) => key.replace(/^frc/i, "")).join(", ")}`, "Shared updates are not independently observed robot contributions."], sampleSize: 1, confidence: "low", suggestedAction: "Review the alliance result and score breakdown. Do not attribute the update to an individual robot.", severity: Math.abs(updates[0]) >= 20 ? "high" : "medium" });
  }
  const combinations = new Map<string, AllianceResult[]>();
  for (const item of allianceResults) if (item.residual !== null && item.teamKeys.length === 3) {
    const key = [...item.teamKeys].sort().join("-");
    combinations.set(key, [...(combinations.get(key) ?? []), item]);
  }
  for (const [key, items] of combinations) {
    if (items.length < 2) continue;
    const average = mean(items.map((item) => item.residual ?? 0)) ?? 0;
    if (Math.abs(average) < 20) continue;
    findings.push({ id: `alliance:${key}`, category: "alliance-pattern", subject: `Alliance ${key.split("-").map((value) => value.replace(/^frc/i, "")).join(" · ")}`, title: average > 0 ? "Repeated positive alliance residuals" : "Repeated negative alliance residuals", description: `This exact three-team combination averaged ${average > 0 ? "+" : ""}${average.toFixed(1)} points relative to prediction.`, evidence: items.map((item) => `${item.matchLabel}: ${item.residual?.toFixed(1)} points`), sampleSize: items.length, confidence: confidence(items.length), suggestedAction: "Review repeated matchups and partner context. This describes the combination, not an individual team's contribution.", severity: items.length >= 3 && Math.abs(average) >= 35 ? "high" : "low" });
  }
  return findings.sort((a, b) => ({ high: 3, medium: 2, low: 1 }[b.severity] - { high: 3, medium: 2, low: 1 }[a.severity]) || b.sampleSize - a.sampleSize);
}
