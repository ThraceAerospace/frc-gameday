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
  if (values.length === 1) return 1;
  // Use the midpoint rank for ties so equal EPA values receive the same percentile.
  const below = values.filter((candidate) => candidate < value).length;
  const equal = values.filter((candidate) => candidate === value).length;
  return (below + (equal - 1) / 2) / (values.length - 1);
}
function ordinal(value: number): string {
  const lastTwo = value % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? "th"
    : value % 10 === 1 ? "st"
    : value % 10 === 2 ? "nd"
    : value % 10 === 3 ? "rd" : "th";
  return `${value}${suffix}`;
}
export function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
export function standardDeviation(values: number[]): number | null {
  if (!values.length) return null;
  const average = mean(values) ?? 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}
function sampleStandardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values) ?? 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
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
  const contributionByTeam = new Map<string, number[]>();
  for (const record of records) {
    for (const color of ["red", "blue"] as const) {
      const teamKeys = record.match.alliances[color].team_keys ?? [];
      if (teamKeys.length !== 3) continue;
      const values = teamKeys.map((teamKey) => numberOrNull(epaFor(record, teamKey, "pre_epas")?.epa));
      if (values.some((value) => value === null || value < 0)) continue;
      const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      if (!(total > 0)) continue;
      teamKeys.forEach((teamKey, index) => {
        const value = values[index];
        if (value === null) return;
        const samples = contributionByTeam.get(teamKey) ?? [];
        samples.push(value / total * 100);
        contributionByTeam.set(teamKey, samples);
      });
    }
  }
  const rows = teams.map((team) => {
    const current = latest.get(String(team.team_number));
    const contributionSamples = contributionByTeam.get(team.key) ?? [];
    return {
      teamKey: team.key, teamNumber: team.team_number, name: team.nickname || team.name || `Team ${team.team_number}`,
      opr: numberOrNull(oprs?.oprs?.[team.key]), dpr: numberOrNull(oprs?.dprs?.[team.key]), ccwm: numberOrNull(oprs?.ccwms?.[team.key]),
      epa: numberOrNull(current?.epa?.epa), autoEpa: numberOrNull(current?.epa?.auto_epa), teleopEpa: numberOrNull(current?.epa?.teleop_epa), endgameEpa: numberOrNull(current?.epa?.endgame_epa),
      matchesSeen: current?.matchesSeen ?? 0, epaPercentile: null as number | null,
      epaContributionPercent: mean(contributionSamples), epaContributionSamples: contributionSamples.length,
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
      : `Statbotics EPA is ${team.epa.toFixed(1)} (${team.epaPercentile === null ? "event percentile unavailable" : `about the ${ordinal(Math.round(team.epaPercentile * 100))} event percentile`}), with ${team.matchesSeen} team appearances represented in the current sample.`);
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
  const finite = (value: number | null | undefined): value is number =>
    typeof value === "number" && Number.isFinite(value);
  const componentValue = (
    record: import("./types").SeasonCohortRecord | undefined,
    keys: string[],
  ): number | null => {
    for (const key of keys) {
      const value = record?.breakdown[key];
      if (finite(value)) return value;
    }
    return null;
  };
  const valuesForEvent = (eventKey: string) => cohort.records.flatMap((record) =>
    record.event.key === eventKey && record.status === "ready" && finite(record.epaTotal)
      ? [{ teamNumber: record.teamNumber, epa: record.epaTotal }] : [],
  );
  const currentEventEPARecords = valuesForEvent(targetEventKey);
  const currentEventEPAValues = currentEventEPARecords.map((record) => record.epa);
  const epaRank = (records: { teamNumber: number; epa: number }[], epa: number) => ({
    rank: 1 + records.filter((record) => record.epa > epa).length,
    size: records.length,
  });
  const componentDefinitions = {
    auto: ["auto_epa", "auto", "auto_points"],
    teleop: ["teleop_epa", "teleop", "teleop_points"],
    endgame: ["endgame_epa", "endgame", "endgame_points"],
  } as const;

  // Select the latest official prior event first, regardless of whether its
  // Statbotics record is usable. If that latest event has no usable record,
  // the team is excluded rather than silently falling back to an older event.
  const comparisons = teams.flatMap((team) => {
    const current = cohort.records.find((record) =>
      record.teamNumber === team.teamNumber && record.event.key === targetEventKey,
    );
    const prior = cohort.records
      .filter((record) => record.teamNumber === team.teamNumber && record.event.startDate < targetStartDate)
      .sort((a, b) => b.event.startDate.localeCompare(a.event.startDate))[0];
    if (!current || current.status !== "ready" || !finite(current.epaTotal) ||
        !prior || prior.status !== "ready" || !finite(prior.epaTotal)) return [];

    const priorEventEPARecords = valuesForEvent(prior.event.key);
    const priorEpaStanding = epaRank(priorEventEPARecords, prior.epaTotal);
    const currentEpaStanding = epaRank(currentEventEPARecords, current.epaTotal);
    const components = {
      auto: (() => {
        const before = componentValue(prior, [...componentDefinitions.auto]);
        const now = componentValue(current, [...componentDefinitions.auto]);
        return before !== null && now !== null ? { prior: before, current: now, change: now - before } : null;
      })(),
      teleop: (() => {
        const before = componentValue(prior, [...componentDefinitions.teleop]);
        const now = componentValue(current, [...componentDefinitions.teleop]);
        return before !== null && now !== null ? { prior: before, current: now, change: now - before } : null;
      })(),
      endgame: (() => {
        const before = componentValue(prior, [...componentDefinitions.endgame]);
        const now = componentValue(current, [...componentDefinitions.endgame]);
        return before !== null && now !== null ? { prior: before, current: now, change: now - before } : null;
      })(),
    };
    return [{
      teamNumber: team.teamNumber,
      priorEvent: { key: prior.event.key, name: prior.event.name, startDate: prior.event.startDate },
      priorEPA: prior.epaTotal,
      currentEPA: current.epaTotal,
      currentEpaPercentile: percentile(currentEventEPAValues, current.epaTotal),
      priorEpaRank: priorEpaStanding.rank,
      priorEpaCohortSize: priorEpaStanding.size,
      currentEpaRank: currentEpaStanding.rank,
      currentEpaCohortSize: currentEpaStanding.size,
      change: current.epaTotal - prior.epaTotal,
      components,
    }];
  });

  const rankFor = (select: (item: typeof comparisons[number]) => number | null) => {
    const eligible = comparisons.flatMap((item) => {
      const change = select(item);
      return change === null ? [] : [{ teamNumber: item.teamNumber, change }];
    });
    return new Map(eligible.map((item) => [
      item.teamNumber,
      {
        cohortRank: 1 + eligible.filter((other) => other.change > item.change).length,
        cohortSize: eligible.length,
      },
    ]));
  };
  const totalRanks = rankFor((item) => item.change);
  // Component denominators are independent of total-EPA eligibility. A team
  // with valid component snapshots still belongs in that component's ranking
  // even if its total-points field is unavailable.
  const rankComponent = (key: keyof typeof componentDefinitions) => {
    const eligible = teams.flatMap((team) => {
      const current = cohort.records.find((record) =>
        record.teamNumber === team.teamNumber && record.event.key === targetEventKey,
      );
      const prior = cohort.records
        .filter((record) => record.teamNumber === team.teamNumber && record.event.startDate < targetStartDate)
        .sort((a, b) => b.event.startDate.localeCompare(a.event.startDate))[0];
      if (!current || current.status !== "ready" || !prior || prior.status !== "ready") return [];
      const before = componentValue(prior, [...componentDefinitions[key]]);
      const now = componentValue(current, [...componentDefinitions[key]]);
      return before !== null && now !== null ? [{ teamNumber: team.teamNumber, change: now - before }] : [];
    });
    return new Map(eligible.map((item) => [
      item.teamNumber,
      {
        cohortRank: 1 + eligible.filter((other) => other.change > item.change).length,
        cohortSize: eligible.length,
      },
    ]));
  };
  const componentRanks = {
    auto: rankComponent("auto"),
    teleop: rankComponent("teleop"),
    endgame: rankComponent("endgame"),
  };
  const byTeam = new Map(comparisons.map((item) => {
    const totalRank = totalRanks.get(item.teamNumber)!;
    const rankedComponent = (key: keyof typeof componentRanks) => {
      const value = item.components[key];
      const rank = componentRanks[key].get(item.teamNumber);
      return value && rank ? { ...value, ...rank } : null;
    };
    return [item.teamNumber, {
      ...item,
      ...totalRank,
      components: {
        auto: rankedComponent("auto"),
        teleop: rankedComponent("teleop"),
        endgame: rankedComponent("endgame"),
      },
    }] as const;
  }));

  return insights.map((insight) => {
    const history = cohort.records.filter((record) => record.teamNumber === insight.teamNumber)
      .sort((a, b) => a.event.startDate.localeCompare(b.event.startDate))
      .map((record) => ({
        event: { key: record.event.key, name: record.event.name, startDate: record.event.startDate },
        epaTotal: record.epaTotal, matches: record.matches, status: record.status,
      }));
    const comparison = byTeam.get(insight.teamNumber) ?? null;
    if (!comparison) return { ...insight, seasonComparison: null, seasonHistory: history };
    const ordinal = (value: number) => {
      const n = value % 100;
      return n >= 11 && n <= 13 ? "th" : value % 10 === 1 ? "st" : value % 10 === 2 ? "nd" : value % 10 === 3 ? "rd" : "th";
    };
    return {
      ...insight,
      seasonComparison: comparison,
      seasonHistory: history,
      summary: [...insight.summary,
        `Compared with ${comparison.priorEvent.name}, event EPA ${comparison.change >= 0 ? "increased" : "decreased"} by ${Math.abs(comparison.change).toFixed(1)} points; ranked ${comparison.cohortRank}${ordinal(comparison.cohortRank)} among ${comparison.cohortSize} event teams with usable current and most-recent-prior-event records.`],
    };
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

/**
 * Event-wide qualification diagnostics. Penalty points are credited to an alliance
 * by TBA and are not attributed to a robot.
 */
export function buildQualificationAnalysis(
  records: AnalyticsMatch[],
  allEventMatches: TBAMatch[],
  allianceResults: AllianceResult[],
  playoffType?: number | null,
): import("./types").QualificationAnalysis {
  const qualifications = records
    .filter(({ match }) => match.comp_level.toLowerCase() === "qm")
    .sort((a, b) => a.match.match_number - b.match.match_number);
  const validOutcomes = qualifications.flatMap((record) => {
    const probability = numberOrNull(record.statbotics?.pred?.red_win_prob);
    const winner = record.match.winning_alliance;
    if (probability === null || probability < 0 || probability > 1 ||
      (winner !== "red" && winner !== "blue") ||
      record.match.alliances.red.score < 0 || record.match.alliances.blue.score < 0) return [];
    const predictedWinner = probability >= 0.5 ? "red" as const : "blue" as const;
    return [{
      matchKey: record.match.key, matchLabel: matchLabel(record.match, playoffType),
      probability, winner, predictedWinner,
      correct: predictedWinner === winner,
      confidence: Math.max(probability, 1 - probability),
    }];
  });
  const binRanges = [
    { label: "0–20%", min: 0, max: 0.2 },
    { label: "20–40%", min: 0.2, max: 0.4 },
    { label: "40–60%", min: 0.4, max: 0.6 },
    { label: "60–80%", min: 0.6, max: 0.8 },
    { label: "80–100%", min: 0.8, max: 1.000001 },
  ];
  const bins = binRanges.flatMap((range) => {
    const items = validOutcomes.filter((item) => item.probability >= range.min && item.probability < range.max);
    if (!items.length) return [];
    const meanPredicted = mean(items.map((item) => item.probability)) ?? 0;
    const observedRedWinRate = mean(items.map((item) => item.winner === "red" ? 1 : 0)) ?? 0;
    return [{ label: range.label, count: items.length, meanPredicted, observedRedWinRate, calibrationError: observedRedWinRate - meanPredicted }];
  });
  const scoreResults = allianceResults.filter((item) =>
    item.compLevel.toLowerCase() === "qm" && item.actual !== null && item.predicted !== null && item.residual !== null,
  );
  const residuals = scoreResults.map((item) => item.residual as number);
  const scorePrediction = {
    allianceCount: residuals.length,
    meanAbsoluteError: mean(residuals.map(Math.abs)),
    rootMeanSquareError: residuals.length ? Math.sqrt(mean(residuals.map((value) => value * value)) ?? 0) : null,
    meanResidual: mean(residuals),
  };
  const thirds = [
    { label: "Early qualifications", start: 0, end: Math.ceil(qualifications.length / 3) },
    { label: "Middle qualifications", start: Math.ceil(qualifications.length / 3), end: Math.ceil(2 * qualifications.length / 3) },
    { label: "Late qualifications", start: Math.ceil(2 * qualifications.length / 3), end: qualifications.length },
  ];
  const progression = thirds.flatMap((third) => {
    const period = qualifications.slice(third.start, third.end);
    if (!period.length) return [];
    const keys = new Set(period.map((record) => record.match.key));
    const values = scoreResults.filter((item) => keys.has(item.matchKey)).map((item) => item.residual as number);
    return [{
      label: third.label, firstMatch: period[0].match.match_number,
      lastMatch: period[period.length - 1].match.match_number, allianceCount: values.length,
      meanAbsoluteError: mean(values.map(Math.abs)), meanResidual: mean(values),
    }];
  });
  const penaltyRows = allEventMatches
    .filter((match) => match.comp_level.toLowerCase() === "qm" &&
      match.alliances.red.score >= 0 && match.alliances.blue.score >= 0)
    .flatMap((match) => {
      const breakdown = match.score_breakdown as unknown as Record<string, Record<string, unknown>> | null;
      if (!breakdown?.red || !breakdown?.blue) return [];
      const points = (color: "red" | "blue") => {
        const values = breakdown[color];
        const raw = numberOrNull(values.foulPoints) ?? numberOrNull(values.foul_points);
        return raw !== null && raw >= 0 ? raw : null;
      };
      const count = (color: "red" | "blue") => {
        const values = breakdown[color];
        const minor = numberOrNull(values.minorFoulCount) ?? numberOrNull(values.minor_foul_count);
        const major = numberOrNull(values.majorFoulCount) ?? numberOrNull(values.major_foul_count);
        // TBA's 2026 score breakdown renamed the legacy foul/tech-foul pair.
        // Prefer the modern pair when either field is present; otherwise use
        // the legacy pair used through 2025.
        if (minor !== null || major !== null) {
          return Math.max(0, minor ?? 0) + Math.max(0, major ?? 0);
        }
        const fouls = numberOrNull(values.foulCount) ?? numberOrNull(values.foul_count);
        const technical = numberOrNull(values.techFoulCount) ?? numberOrNull(values.tech_foul_count);
        return fouls === null && technical === null ? null : Math.max(0, fouls ?? 0) + Math.max(0, technical ?? 0);
      };
      const redPenaltyPoints = points("red"), bluePenaltyPoints = points("blue");
      if (redPenaltyPoints === null || bluePenaltyPoints === null) return [];
      return [{
        matchKey: match.key, matchLabel: matchLabel(match, playoffType), matchNumber: match.match_number,
        redPenaltyCount: count("red"), bluePenaltyCount: count("blue"),
        redPenaltyPoints, bluePenaltyPoints, totalPenaltyPoints: redPenaltyPoints + bluePenaltyPoints,
      }];
    }).sort((a, b) => a.matchNumber - b.matchNumber);
  const alliancePenaltyValues = penaltyRows.flatMap((item) => [item.redPenaltyPoints, item.bluePenaltyPoints]).sort((a, b) => a - b);
  const quantile = (values: number[], probability: number) => {
    if (!values.length) return null;
    const position = (values.length - 1) * probability;
    const lower = Math.floor(position), upper = Math.ceil(position);
    return values[lower] + (values[upper] - values[lower]) * (position - lower);
  };
  const median = quantile(alliancePenaltyValues, 0.5), q1 = quantile(alliancePenaltyValues, 0.25), q3 = quantile(alliancePenaltyValues, 0.75);
  const iqr = q1 !== null && q3 !== null ? q3 - q1 : null;
  const outlierThreshold = alliancePenaltyValues.length >= 10 && median !== null && iqr !== null
    ? (iqr > 0 ? q3! + 1.5 * iqr : median) : null;
  const flaggedMatches = outlierThreshold === null ? [] : penaltyRows
    .filter((item) => item.redPenaltyPoints > outlierThreshold || item.bluePenaltyPoints > outlierThreshold)
    .map((item) => ({
      ...item,
      redFlagged: item.redPenaltyPoints > outlierThreshold,
      blueFlagged: item.bluePenaltyPoints > outlierThreshold,
    }));
  const totalPenaltyPoints = penaltyRows.reduce((sum, item) => sum + item.totalPenaltyPoints, 0);
  return {
    predictionCalibration: {
      matchCount: validOutcomes.length,
      correctCount: validOutcomes.filter((item) => item.correct).length,
      underdogWins: validOutcomes.filter((item) => !item.correct).length,
      accuracy: validOutcomes.length ? validOutcomes.filter((item) => item.correct).length / validOutcomes.length : null,
      brierScore: validOutcomes.length ? mean(validOutcomes.map((item) =>
        (item.probability - (item.winner === "red" ? 1 : 0)) ** 2)) : null,
      highConfidenceMisses: validOutcomes.filter((item) => item.confidence >= 0.8 && !item.correct)
        .map((item) => ({ matchKey: item.matchKey, matchLabel: item.matchLabel, predictedWinner: item.predictedWinner, probability: item.confidence })),
      bins,
    },
    scorePrediction,
    progression,
    penalties: {
      sampleSize: penaltyRows.length,
      matchesWithPenaltyPoints: penaltyRows.filter((item) => item.totalPenaltyPoints > 0).length,
      totalPenaltyPoints,
      meanPenaltyPoints: penaltyRows.length ? totalPenaltyPoints / penaltyRows.length : null, medianPenaltyPoints: median, outlierThreshold,
      flaggedMatches,
    },
  };
}

/** Resolve a played three-team match roster to the complete official TBA alliance roster. */
function officialPlayoffAlliance(
  teamKeys: string[],
  alliances: TBAEliminationAlliance[] | null,
): { name: string | null; teamKeys: string[] } | null {
  if (!alliances?.length || teamKeys.length !== 3) return null;
  const played = new Set(teamKeys.map((key) => key.toLowerCase()));
  const candidates = alliances.flatMap((alliance) => {
    const picks = [...(alliance.picks ?? [])];
    // A backup replaces the team listed in "out"; preserve the four-person roster.
    if (alliance.backup?.in && alliance.backup?.out) {
      const outIndex = picks.findIndex((key) => key.toLowerCase() === alliance.backup!.out!.toLowerCase());
      if (outIndex >= 0) picks[outIndex] = alliance.backup.in;
      else if (!picks.some((key) => key.toLowerCase() === alliance.backup!.in!.toLowerCase())) picks.push(alliance.backup.in);
    }
    const roster = [...new Map(picks.map((key) => [key.toLowerCase(), key])).values()];
    return roster.length >= 3 && [...played].every((key) => roster.some((member) => member.toLowerCase() === key))
      ? [{ name: typeof alliance.name === "string" && alliance.name.trim() ? alliance.name.trim() : null, teamKeys: roster }]
      : [];
  });
  return candidates.length === 1 ? candidates[0] : null;
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
  const officialRosters = new Map<string, string[]>();

  for (const item of playoffs) {
    if (item.teamKeys.length !== 3) continue;
    const official = officialPlayoffAlliance(item.teamKeys, officialAlliances);
    const roster = official?.teamKeys ?? [...new Set(item.teamKeys)].sort();
    const key = official
      ? `official:${[...roster].map((team) => team.toLowerCase()).sort().join("|")}`
      : `teams:${roster.join("|")}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
    names.set(key, official?.name ?? null);
    if (official) officialRosters.set(key, roster);
  }

  const alliances = [...groups.entries()].map(([key, items]) => {
    const scored = items.filter((item) => item.predicted !== null && item.residual !== null);
    const residuals = scored.map((item) => item.residual as number);
    const teamKeys = officialRosters.get(key) ?? [...new Set(items.flatMap((item) => item.teamKeys))].sort();
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
      residualStandardDeviation: sampleStandardDeviation(residuals),
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
