import type { StatboticsEPA } from "@/lib/statbotics/types";
import type { AllianceResult, AnalyticsMatch, ReviewFinding, TeamAnalyticsRow } from "./types";

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function statboticsTeamKey(teamKey: string): string {
  return String(Number(teamKey.replace(/^frc/i, "")));
}
function matchLabel(match: AnalyticsMatch["match"]): string {
  // TBA normally supplies comp_level/set_number/match_number, but tolerate
  // incomplete records by recovering the label from the canonical match key.
  const keyParts = typeof match.key === "string"
    ? match.key.match(/_([a-z]{2})(?:(\\d+)m)?(\\d+)$/i)
    : null;
  const level = typeof match.comp_level === "string" && match.comp_level.length
    ? match.comp_level
    : keyParts?.[1]?.toLowerCase();
  const matchNumber = Number.isFinite(match.match_number)
    ? match.match_number
    : Number(keyParts?.[3]);
  const setNumber = Number.isFinite(match.set_number)
    ? match.set_number
    : Number(keyParts?.[2]);

  if (level === "qm" || level === "pm") return `QM ${Number.isFinite(matchNumber) ? matchNumber : "?"}`;
  if (level) {
    const set = Number.isFinite(setNumber) ? setNumber : "?";
    const number = Number.isFinite(matchNumber) ? matchNumber : "?";
    return `${level.toUpperCase()} ${set} · ${number}`;
  }
  return typeof match.key === "string" ? match.key : "Unknown match";
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
    return {
      teamKey: team.key, teamNumber: team.team_number, name: team.nickname || team.name || `Team ${team.team_number}`,
      opr: numberOrNull(oprs?.oprs?.[team.key]), dpr: numberOrNull(oprs?.dprs?.[team.key]), ccwm: numberOrNull(oprs?.ccwms?.[team.key]),
      epa: numberOrNull(current?.epa?.epa), autoEpa: numberOrNull(current?.epa?.auto_epa), teleopEpa: numberOrNull(current?.epa?.teleop_epa), endgameEpa: numberOrNull(current?.epa?.endgame_epa),
      matchesSeen: current?.matchesSeen ?? 0, epaPercentile: null as number | null,
    };
  });
  const epaValues = rows.flatMap((row) => row.epa === null ? [] : [row.epa]);
  return rows.map((row) => ({
    ...row,
    epaPercentile: row.epa === null ? null : percentile(epaValues, row.epa),
  }));
}
function sampleCoverage(n: number): ReviewFinding["sampleCoverage"] { return n >= 12 ? "high" : n >= 6 ? "medium" : "low"; }
export function buildReviewFindings(records: AnalyticsMatch[], allianceResults: AllianceResult[], teams: TeamAnalyticsRow[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const residuals = allianceResults.flatMap((item) => item.residual === null ? [] : [item.residual]);
  const spread = standardDeviation(residuals) ?? 0;
  const threshold = Math.max(25, spread * 1.5);
  if (residuals.length >= 4) for (const item of allianceResults) {
    if (item.residual === null || Math.abs(item.residual) < threshold) continue;
    findings.push({ id: `residual:${item.matchKey}:${item.color}`, category: "score-residual", subject: `${item.matchLabel} · ${item.color} alliance`, title: item.residual > 0 ? "Alliance scored well above prediction" : "Alliance scored well below prediction", description: `Actual alliance score differed from prediction by ${Math.round(item.residual)} points.`, evidence: [`Predicted ${Math.round(item.predicted ?? 0)} · actual ${item.actual}`, `Sample residual SD: ${spread.toFixed(1)} points`], sampleSize: residuals.length, sampleCoverage: sampleCoverage(residuals.length), suggestedAction: "Review the match and webcast. This is an alliance-level result, not an attribution to a robot.", severity: Math.abs(item.residual) >= threshold * 2 ? "high" : "medium" });
  }
  // Playoff alliances are deliberately assembled as fixed three-team selections
  // across rounds. They are not repeated scouting combinations. Only qualification
  // matches are eligible for this signal.
  const qualificationResults = allianceResults.filter((item) => {
    if (item.compLevel) return item.compLevel.toLowerCase() === "qm";
    return /_qm\d+$/i.test(item.matchKey);
  });
  const combinations = new Map<string, AllianceResult[]>();
  for (const item of qualificationResults) if (item.residual !== null && item.teamKeys.length === 3) {
    const key = [...item.teamKeys].sort().join("-");
    combinations.set(key, [...(combinations.get(key) ?? []), item]);
  }
  for (const [key, items] of combinations) {
    if (items.length < 2) continue;
    const average = mean(items.map((item) => item.residual ?? 0)) ?? 0;
    if (Math.abs(average) < 20) continue;
    findings.push({ id: `alliance:quals:${key}`, category: "alliance-pattern", subject: `Alliance ${key.split("-").map((value) => value.replace(/^frc/i, "")).join(" · ")}`, title: average > 0 ? "Repeated positive qualification residuals" : "Repeated negative qualification residuals", description: `This exact three-team combination averaged ${average > 0 ? "+" : ""}${average.toFixed(1)} points relative to prediction across ${items.length} qualification matches.`, evidence: items.map((item) => `${item.matchLabel}: ${item.residual?.toFixed(1)} points`), sampleSize: items.length, sampleCoverage: sampleCoverage(items.length), suggestedAction: "Review these qualification matches and partner context. This describes the alliance combination, not an individual team's contribution.", severity: items.length >= 3 && Math.abs(average) >= 35 ? "high" : "low" });
  }
  return findings.sort((a, b) => ({ high: 3, medium: 2, low: 1 }[b.severity] - { high: 3, medium: 2, low: 1 }[a.severity]) || b.sampleSize - a.sampleSize);
}


/**
 * Per-team briefs summarize shared event evidence. They are correlation and
 * review prompts only; alliance results and model updates are not robot attribution.
 */
export function buildTeamInsights(
  records: AnalyticsMatch[],
  allianceResults: AllianceResult[],
  teams: TeamAnalyticsRow[],
  rankings: { rankings?: { team_key: string; rank: number; record?: { wins: number; losses: number; ties: number } | null }[] } | null,
): import("./types").TeamInsight[] {
  const residuals = allianceResults.flatMap((item) => item.residual === null ? [] : [item.residual]);
  const residualThreshold = Math.max(25, (standardDeviation(residuals) ?? 0) * 1.5);
  const rankingByTeam = new Map((rankings?.rankings ?? []).map((item) => [item.team_key, item]));
  const resultByMatchAlliance = new Map(allianceResults.map((item) => [item.matchKey + ":" + item.color, item]));
  return teams.map((team) => {
    const appearances = records.flatMap((record) => {
      const alliance = record.match.alliances.red.team_keys.includes(team.teamKey) ? "red" as const
        : record.match.alliances.blue.team_keys.includes(team.teamKey) ? "blue" as const : null;
      if (!alliance) return [];
      const own = record.match.alliances[alliance];
      const opposing = record.match.alliances[alliance === "red" ? "blue" : "red"];
      const result = resultByMatchAlliance.get(record.match.key + ":" + alliance);
      const id = statboticsTeamKey(team.teamKey);
      const preEPA = numberOrNull(record.statbotics?.pre_epas?.[id]?.epa);
      const postEPA = numberOrNull(record.statbotics?.epas?.[id]?.epa);
      const deltaEPA = preEPA !== null && postEPA !== null ? postEPA - preEPA : null;
      const redProbability = numberOrNull(record.statbotics?.pred?.red_win_prob ?? record.statbotics?.prediction?.red_win_prob);
      const winProbability = redProbability === null ? null : alliance === "red" ? redProbability : 1 - redProbability;
      const winner = record.match.winning_alliance;
      const won = winner === "red" || winner === "blue" ? winner === alliance : null;
      const reasons: string[] = [];
      if (result?.residual !== null && result?.residual !== undefined && Math.abs(result.residual) >= residualThreshold) {
        reasons.push(`Alliance score differed from model prediction by ${result.residual > 0 ? "+" : ""}${result.residual.toFixed(1)} points`);
      }
      if (winProbability !== null && won !== null && ((winProbability >= 0.8 && !won) || (winProbability <= 0.2 && won))) {
        reasons.push(`Outcome differed from the model's ${Math.round(Math.max(winProbability, 1 - winProbability) * 100)}% win-probability expectation`);
      }
      return [{
        matchKey: record.match.key, matchLabel: matchLabel(record.match), alliance,
        partners: own.team_keys.filter((key) => key !== team.teamKey).map((key) => Number(key.replace(/^frc/i, ""))).filter(Number.isFinite),
        opponents: opposing.team_keys.map((key) => Number(key.replace(/^frc/i, ""))).filter(Number.isFinite),
        predicted: result?.predicted ?? null, actual: result?.actual ?? null, residual: result?.residual ?? null,
        winProbability, won, preEPA, postEPA, deltaEPA, reasons,
        completed: typeof own.score === "number" && own.score >= 0 && typeof opposing.score === "number" && opposing.score >= 0,
      }];
    });
    const epaDeltas = appearances.flatMap((item) => item.deltaEPA === null ? [] : [item.deltaEPA]);
    const epaDeltaThreshold = Math.max(2, (standardDeviation(epaDeltas) ?? 0) * 1.5);
    for (const item of appearances) {
      if (item.deltaEPA !== null && Math.abs(item.deltaEPA) >= epaDeltaThreshold) {
        item.reasons.push(`Statbotics updated this team's EPA by ${item.deltaEPA > 0 ? "+" : ""}${item.deltaEPA.toFixed(2)}; check whether this was a shared alliance model update`);
      }
    }
    const completedMatches = appearances.filter((item) => item.completed).length;
    const trend = appearances.flatMap((item) => item.postEPA !== null || item.preEPA !== null
      ? [{ matchKey: item.matchKey, matchLabel: item.matchLabel, epa: item.postEPA ?? item.preEPA }] : []);
    const first = appearances.find((item) => item.preEPA !== null)?.preEPA ?? null;
    const last = [...appearances].reverse().find((item) => item.postEPA !== null)?.postEPA ?? null;
    const epaChange = first !== null && last !== null ? last - first : null;
    const ranking = rankingByTeam.get(team.teamKey);
    const metrics = {
      rank: ranking?.rank ?? null, wins: ranking?.record?.wins ?? null, losses: ranking?.record?.losses ?? null, ties: ranking?.record?.ties ?? null,
      matchesSeen: appearances.length, completedMatches, epa: team.epa, epaPercentile: team.epaPercentile,
      autoEpa: team.autoEpa, teleopEpa: team.teleopEpa, endgameEpa: team.endgameEpa,
      epaStart: first, epaEnd: last, epaChange,
    };
    const summary: string[] = [];
    summary.push(metrics.rank === null ? "Official qualification standing is not available yet."
      : `Official qualification rank: #${metrics.rank}${metrics.wins === null ? "" : ` · record ${metrics.wins}–${metrics.losses}–${metrics.ties}`}.`);
    summary.push(team.epa === null ? "Statbotics EPA is not available in the current match sample."
      : `Statbotics EPA is ${team.epa.toFixed(1)} (${team.epaPercentile === null ? "event percentile unavailable" : `about the ${Math.round(team.epaPercentile * 100)}th event percentile`}), with ${team.matchesSeen} team appearances represented in the current sample.`);
    const components = [["auto",team.autoEpa],["teleop",team.teleopEpa],["endgame",team.endgameEpa]].filter((item): item is [string,number] => item[1] !== null);
    if (components.length) {
      const largest = [...components].sort((a,b)=>b[1]-a[1])[0];
      summary.push(`EPA component estimates: auto ${fmtValue(team.autoEpa)}, teleop ${fmtValue(team.teleopEpa)}, endgame ${fmtValue(team.endgameEpa)}; ${largest[0]} is the largest estimate.`);
    }
    if (epaChange !== null) summary.push(`Across the observed event sequence, EPA moved from ${first!.toFixed(1)} to ${last!.toFixed(1)} (${epaChange > 0 ? "+" : ""}${epaChange.toFixed(1)}).`);
    summary.push(`${completedMatches} completed matches represented; ${appearances.filter((item)=>item.reasons.length).length} match(es) have review signals.`);
    return {
      teamNumber: team.teamNumber, summary, metrics,
      epaTrend: trend, seasonComparison: null,
      reviewMatches: appearances.filter((item)=>item.reasons.length).map(({completed: _completed,...item})=>item),
    };
  });
}
function fmtValue(value: number | null): string { return value === null ? "—" : value.toFixed(1); }


export function buildSeasonAwareTeamInsights(
  records: AnalyticsMatch[], allianceResults: AllianceResult[], teams: TeamAnalyticsRow[],
  rankings: { rankings?: { team_key: string; rank: number; record?: { wins: number; losses: number; ties: number } | null }[] } | null,
  cohort: import("./types").SeasonCohortSnapshot, targetEventKey: string, targetStartDate: string,
): import("./types").TeamInsight[] {
  const insights = buildTeamInsights(records, allianceResults, teams, rankings);
  const usable = cohort.records.filter((record) => record.status === "ready" && record.epaTotal !== null);
  const changes = teams.flatMap((team) => {
    const current = usable.find((record) => record.teamNumber === team.teamNumber && record.event.key === targetEventKey);
    const prior = usable.filter((record) => record.teamNumber === team.teamNumber && record.event.startDate < targetStartDate)
      .sort((a,b) => b.event.startDate.localeCompare(a.event.startDate))[0];
    if (!current || !prior || current.epaTotal === null || prior.epaTotal === null) return [];
    return [{ teamNumber: team.teamNumber, priorEvent: { key: prior.event.key, name: prior.event.name, startDate: prior.event.startDate }, priorEPA: prior.epaTotal, currentEPA: current.epaTotal, change: current.epaTotal - prior.epaTotal }];
  });
  const ordered = [...changes].sort((a,b) => b.change-a.change);
  const byTeam = new Map(changes.map((item) => [item.teamNumber, { ...item, cohortRank: ordered.findIndex((other) => other.teamNumber === item.teamNumber)+1, cohortSize: ordered.length }]));
  return insights.map((insight) => {
    const history = cohort.records.filter((record) => record.teamNumber === insight.teamNumber)
      .sort((a,b) => a.event.startDate.localeCompare(b.event.startDate))
      .map((record) => ({ event: { key: record.event.key, name: record.event.name, startDate: record.event.startDate }, epaTotal: record.epaTotal, matches: record.matches, status: record.status }));
    const comparison = byTeam.get(insight.teamNumber) ?? null;
    if (!comparison) return { ...insight, seasonComparison: null, seasonHistory: history };
    const ordinal = (value:number) => { const n=value%100; return n>=11&&n<=13?"th":value%10===1?"st":value%10===2?"nd":value%10===3?"rd":"th"; };
    return { ...insight, seasonComparison: comparison, seasonHistory: history, summary: [...insight.summary,
      `Compared with ${comparison.priorEvent.name}, event EPA ${comparison.change>=0?"increased":"decreased"} by ${Math.abs(comparison.change).toFixed(1)} points; ${comparison.cohortRank}${ordinal(comparison.cohortRank)}-largest change among ${comparison.cohortSize} event teams with usable prior-event records.`] };
  });
}
