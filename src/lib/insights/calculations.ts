import type { StatboticsEPA } from "@/lib/statbotics/types";
import type { TBAEliminationAlliance } from "@/lib/tba/types";
import { matchShortName } from "@/lib/tba/formatters";
import type { AllianceResult, AnalyticsMatch, ReviewFinding, TeamAnalyticsRow } from "./types";
import type { TBAMatch } from "@/lib/tba/types";

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function statboticsTeamKey(teamKey: string): string {
  return String(Number(teamKey.replace(/^frc/i, "")));
}
function matchLabel(match: AnalyticsMatch["match"], playoffType?: number | null): string {
  return matchShortName(match, playoffType);
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
export function buildAllianceResults(records: AnalyticsMatch[], playoffType?: number | null): AllianceResult[] {
  return records.flatMap(({ match, statbotics }) => (["red", "blue"] as const).map((color) => {
    const alliance = match.alliances[color];
    const predicted = numberOrNull(color === "red" ? statbotics?.pred?.red_score : statbotics?.pred?.blue_score);
    const rawActual = numberOrNull(alliance.score);
    const actual = rawActual !== null && rawActual >= 0 ? rawActual : null;
    const teamKeys = alliance.team_keys ?? [];
    const values = teamKeys.map((key) => numberOrNull(statbotics?.pre_epas?.[statboticsTeamKey(key)]?.epa));
    const preEpaTotal = values.every((value) => value !== null) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
    const outcome = match.winning_alliance === color ? "win" as const
      : match.winning_alliance === (color === "red" ? "blue" : "red") ? "loss" as const
      : match.winning_alliance === "" ? "tie" as const : "unknown" as const;
    return { matchKey: match.key, matchLabel: matchLabel(match, playoffType), compLevel: match.comp_level, color, teamKeys, predicted, actual, residual: actual !== null && predicted !== null ? actual - predicted : null, preEpaTotal, winner: outcome === "win", outcome };
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
export function buildReviewFindings(records: AnalyticsMatch[], allianceResults: AllianceResult[], teams: TeamAnalyticsRow[], allEventMatches: TBAMatch[] = records.map((record) => record.match)): ReviewFinding[] {
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
  // TBA penalty counts belong to the alliance. Treat them as shared exposure,
  // not proof that any individual robot caused the penalties.
  const penaltySamples = new Map<string, number[]>();
  // Penalty evidence comes from the complete TBA event schedule, not the
  // progressively collected Statbotics subset.
  for (const match of allEventMatches) {
    if (match.comp_level.toLowerCase() !== "qm") continue;
    const breakdown = match.score_breakdown as unknown as Record<string, Record<string, unknown>> | null;
    if (!breakdown) continue;
    for (const color of ["red", "blue"] as const) {
      const alliance = match.alliances[color];
      if (typeof alliance.score !== "number" || alliance.score < 0) continue;
      const values = breakdown[color];
      if (!values) continue;
      const major = numberOrNull(values.majorFoulCount);
      const minor = numberOrNull(values.minorFoulCount);
      const legacyFouls = numberOrNull(values.foulCount);
      const technical = numberOrNull(values.techFoulCount);
      const count = major !== null || minor !== null ? (major ?? 0) + (minor ?? 0)
        : legacyFouls !== null || technical !== null ? (legacyFouls ?? 0) + (technical ?? 0) : null;
      if (count === null || count < 0) continue;
      for (const teamKey of alliance.team_keys ?? []) {
        penaltySamples.set(teamKey, [...(penaltySamples.get(teamKey) ?? []), count]);
      }
    }
  }
  const minimumPenaltyMatches = 5;
  const teamPenaltyRates = [...penaltySamples.entries()]
    .filter(([, samples]) => samples.length >= minimumPenaltyMatches)
    .map(([teamKey, samples]) => ({ teamKey, samples, rate: mean(samples) ?? 0 }));
  if (teamPenaltyRates.length >= 6) {
    for (const team of teamPenaltyRates) {
      const peers = teamPenaltyRates.filter((candidate) => candidate.teamKey !== team.teamKey).map((candidate) => candidate.rate);
      const peerMean = mean(peers) ?? 0;
      const peerDeviation = standardDeviation(peers) ?? 0;
      const threshold = peerMean + Math.max(0.5, peerDeviation * 1.5);
      if (team.rate <= threshold) continue;
      const teamNumber = Number(team.teamKey.replace(/^frc/i, ""));
      const teamName = teams.find((candidate) => candidate.teamKey === team.teamKey)?.name ?? `Team ${teamNumber}`;
      const difference = team.rate - peerMean;
      findings.push({
        id: `penalty-frequency:${team.teamKey}`, category: "penalty-frequency", subject: `Team ${teamNumber} · ${teamName}`,
        title: "Unusually high penalty frequency",
        description: `This team's alliances averaged ${team.rate.toFixed(2)} penalty calls per qualification match, above the other eligible teams at this event.`,
        evidence: [
          `${team.samples.reduce((sum, value) => sum + value, 0)} alliance penalty calls across ${team.samples.length} completed qualification matches`,
          `Other eligible teams averaged ${peerMean.toFixed(2)} calls per match`,
          `${difference.toFixed(2)} more calls per match than the peer average`,
        ],
        sampleSize: team.samples.length, sampleCoverage: sampleCoverage(team.samples.length),
        suggestedAction: "Review the team's qualification matches and scouting notes for recurring behaviors. TBA reports these penalties for the whole alliance and does not identify the responsible robot.",
        severity: team.rate > peerMean + Math.max(1, peerDeviation * 2.5) ? "high" : "medium",
      });
    }
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
  playoffType?: number | null,
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
      const redProbability = numberOrNull(record.statbotics?.pred?.red_win_prob);
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
        matchKey: record.match.key, matchLabel: matchLabel(record.match, playoffType), alliance,
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
    const ownAllianceResults = allianceResults.filter((item) => item.compLevel.toLowerCase() === "qm" && item.teamKeys.includes(team.teamKey) && item.residual !== null && item.preEpaTotal !== null);
    const peerMap = new Map<string, number>();
    for (const own of ownAllianceResults) {
      const band = Math.max(5, Math.abs(own.preEpaTotal ?? 0) * 0.2);
      for (const peer of allianceResults) {
        if (peer.compLevel.toLowerCase() !== own.compLevel.toLowerCase() || peer.matchKey === own.matchKey || peer.residual === null || peer.preEpaTotal === null ||
            peer.teamKeys.includes(team.teamKey) || Math.abs(peer.preEpaTotal - (own.preEpaTotal ?? 0)) > band) continue;
        peerMap.set(peer.matchKey + ":" + peer.color, peer.residual);
      }
    }
    const ownResiduals = ownAllianceResults.map((item) => item.residual as number);
    const peerResiduals = [...peerMap.values()];
    const teamMeanResidual = mean(ownResiduals);
    const peerMeanResidual = mean(peerResiduals);
    const peerDifference = teamMeanResidual !== null && peerMeanResidual !== null ? teamMeanResidual - peerMeanResidual : null;
    const peerPerformance = {
      teamMatches: ownResiduals.length, peerAllianceCount: peerResiduals.length,
      teamMeanResidual, peerMeanResidual, difference: peerDifference,
      interpretation: ownResiduals.length < 3 || peerResiduals.length < 5 || peerDifference === null ? "insufficient-sample" as const
        : peerDifference > 10 ? "above-peers" as const : peerDifference < -10 ? "below-peers" as const : "similar-to-peers" as const,
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
      teamNumber: team.teamNumber, summary, metrics, peerPerformance,
      epaTrend: trend, seasonComparison: null, seasonHistory: [],
      reviewMatches: appearances.filter((item)=>item.reasons.length).map(({completed: _completed,...item})=>item),
    };
  });
}
function fmtValue(value: number | null): string { return value === null ? "—" : value.toFixed(1); }


export function buildSeasonAwareTeamInsights(
  records: AnalyticsMatch[], allianceResults: AllianceResult[], teams: TeamAnalyticsRow[],
  rankings: { rankings?: { team_key: string; rank: number; record?: { wins: number; losses: number; ties: number } | null }[] } | null,
  cohort: import("./types").SeasonCohortSnapshot, targetEventKey: string, targetStartDate: string,
  playoffType?: number | null,
): import("./types").TeamInsight[] {
  const insights = buildTeamInsights(records, allianceResults, teams, rankings, playoffType);
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


/** Statbotics exposes win probability, but not an alliance score prediction interval. */
export function buildQualificationAnomalies(records: AnalyticsMatch[], allianceResults: AllianceResult[], playoffType?: number | null): import("./types").QualificationAnomaly[] {
  const qualifications = allianceResults.filter((item) => item.compLevel.toLowerCase() === "qm");
  const residuals = qualifications.flatMap((item) => item.residual === null ? [] : [item.residual]);
  if (residuals.length < 8) return [];
  const center = [...residuals].sort((a,b)=>a-b)[Math.floor(residuals.length/2)];
  const deviations = residuals.map((value)=>Math.abs(value-center)).sort((a,b)=>a-b);
  const spread = 1.4826 * deviations[Math.floor(deviations.length/2)];
  const marginOfError = Math.max(20, 3 * spread);
  const matches = new Map(records.map((record) => [record.match.key, record]));
  const anomalies: import("./types").QualificationAnomaly[] = [];
  for (const item of qualifications) {
    if (item.actual === null || item.predicted === null || item.residual === null) continue;
    const record = matches.get(item.matchKey);
    const redProbability = numberOrNull(record?.statbotics?.pred?.red_win_prob);
    const winProbability = redProbability === null ? null : item.color === "red" ? redProbability : 1 - redProbability;
    const winner = record?.match.winning_alliance;
    const highConfidenceMiss = winProbability !== null && winProbability >= 0.8 &&
      (winner === "red" || winner === "blue") && winner !== item.color;
    const outsideExpectedRange = Math.abs(item.residual-center) > marginOfError;
    if (!outsideExpectedRange && !highConfidenceMiss) continue;
    const z = spread > 0 ? (item.residual-center)/spread : null;
    const reasons: string[] = [];
    if (outsideExpectedRange) reasons.push(`Residual ${item.residual > 0 ? "+" : ""}${item.residual.toFixed(1)} pts is outside the event-calibrated ±${marginOfError.toFixed(1)} pt band around the ${center.toFixed(1)} pt median.`);
    if (highConfidenceMiss) reasons.push(`The model assigned this alliance a ${Math.round((winProbability ?? 0) * 100)}% win probability, but it lost.`);
    anomalies.push({
      id: `qualification:${item.matchKey}:${item.color}`, matchKey: item.matchKey, matchLabel: matchLabel(records.find((record) => record.match.key === item.matchKey)!.match, playoffType),
      alliance: item.color, teamKeys: item.teamKeys, predicted: item.predicted, actual: item.actual,
      residual: item.residual, marginOfError, standardizedResidual: z, winProbability,
      outsideExpectedRange, highConfidenceMiss, severity: highConfidenceMiss || (z !== null && Math.abs(z) >= 3.5) ? "high" : "medium", reasons,
    });
  }
  return anomalies.sort((a,b)=>Number(b.highConfidenceMiss)-Number(a.highConfidenceMiss)||Math.abs(b.standardizedResidual??0)-Math.abs(a.standardizedResidual??0));
}

/** Playoff alliance combinations are separate from qualification combinations. */
function officialPlayoffAllianceName(
  teamKeys: string[],
  alliances: TBAEliminationAlliance[] | null,
): string | null {
  if (!alliances?.length || teamKeys.length !== 3) return null;
  const teamSet = new Set(teamKeys.map((key) => key.toLowerCase()));
  const candidates = alliances.filter((alliance) => {
    if (typeof alliance.name !== "string" || !alliance.name.trim()) return false;
    const selected = new Set([
      ...(alliance.picks ?? []),
      ...(alliance.backup?.in ? [alliance.backup.in] : []),
    ].map((key) => key.toLowerCase()));
    return [...teamSet].every((key) => selected.has(key));
  });
  return candidates.length === 1 ? candidates[0].name!.trim() : null;
}

/** Group scored elimination results by official TBA alliance when available. */
export function buildPlayoffAnalysis(
  allianceResults: AllianceResult[],
  officialAlliances: TBAEliminationAlliance[] | null = null,
): import("./types").PlayoffAnalysis {
  const playoffs = allianceResults.filter((item) =>
    ["ef", "qf", "sf", "f"].includes(item.compLevel.toLowerCase()) && item.actual !== null,
  );
  const average = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const groups = new Map<string, AllianceResult[]>();
  const names = new Map<string, string | null>();

  for (const item of playoffs) {
    if (item.teamKeys.length !== 3) continue;
    const sortedTeams = [...item.teamKeys].sort();
    const name = officialPlayoffAllianceName(item.teamKeys, officialAlliances);
    // Never invent an alliance number or infer a name from array position.
    const key = name ? `name:${name.toLowerCase()}` : `teams:${sortedTeams.join("|")}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
    names.set(key, name);
  }

  const alliances = [...groups.entries()].map(([key, items]) => {
    const scored = items.filter((item) => item.predicted !== null && item.residual !== null);
    const residuals = scored.map((item) => item.residual as number);
    const teamKeys = [...new Set(items.flatMap((item) => item.teamKeys))].sort();
    return {
      name: names.get(key) ?? null,
      teamKeys,
      matchCount: items.length,
      scoredMatchCount: scored.length,
      wins: items.filter((item) => item.outcome === "win").length,
      losses: items.filter((item) => item.outcome === "loss").length,
      ties: items.filter((item) => item.outcome === "tie").length,
      unknownOutcomes: items.filter((item) => item.outcome === "unknown").length,
      meanPredicted: average(scored.map((item) => item.predicted as number)),
      meanActual: average(scored.map((item) => item.actual as number)),
      meanResidual: average(residuals),
      residualStandardDeviation: standardDeviation(residuals),
      matches: items.map((item) => ({
        matchKey: item.matchKey,
        compLevel: item.compLevel,
        color: item.color,
        outcome: item.outcome,
        residual: item.residual,
        actual: item.actual,
        predicted: item.predicted,
      })),
    };
  }).sort((a, b) => b.matchCount - a.matchCount || (a.name ?? "").localeCompare(b.name ?? ""));

  return {
    matchCount: new Set(playoffs.map((item) => item.matchKey)).size,
    allianceCount: alliances.length,
    alliances,
  };
}
