import { redis } from "@/lib/cache/redis";
import { TBA } from "@/lib/tba/service";
import { Statbotics } from "@/lib/statbotics/service";
import { sortMatches } from "@/lib/tba/matchUtils";
import { matchShortName } from "@/lib/tba/formatters";
import type { StatboticsEPA, StatboticsMatch } from "@/lib/statbotics/types";
import type { TBAMatch, TBAEvent } from "@/lib/tba/types";

type TeamMatchRow = {
  matchKey: string;
  matchLabel: string;
  compLevel: TBAMatch["comp_level"];
  event: { key: string; name: string; shortName?: string | null; startDate: string };
  partners: string[];
  opponents: string[];
  alliance: "red" | "blue";
  predicted: number | null;
  actual: number | null;
  residual: number | null;
  opponentPredicted: number | null;
  opponentActual: number | null;
  opponentResidual: number | null;
  alliancePreEPATotal: number | null;
  opponentPreEPATotal: number | null;
  alliancePreComponents: Record<string, number>;
  actualComponents: Record<string, number>;
  redWinProbability: number | null;
  teamWinProbability: number | null;
  rpOutcomes: { key: string; predicted: number | null; achieved: boolean | null }[];
  won: boolean | null;
  preEPA: number | null;
  postEPA: number | null;
  deltaEPA: number | null;
  preComponents: Record<string, number>;
  postComponents: Record<string, number>;
  allianceDeltaSpread: number | null;
  sharedAllianceUpdate: boolean;
  statboticsAvailable: boolean;
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function teamEPA(record: StatboticsMatch | null, teamNumber: number, phase: "pre_epas" | "epas"): StatboticsEPA | undefined {
  return record?.[phase]?.[String(teamNumber)];
}
function components(value: StatboticsEPA | undefined): Record<string, number> {
  if (!value) return {};
  const result: Record<string, number> = {};
  for (const [key, amount] of Object.entries(value)) {
    if (typeof amount === "number" && Number.isFinite(amount) && !/^comp_\d+_epa$/.test(key)) result[key] = amount;
  }
  return result;
}
function label(match: TBAMatch, playoffType?: number | null): string {
  return matchShortName(match, playoffType);
}
async function withConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await worker(items[index]);
    }
  }));
  return result;
}

export const maxDuration = 60;

export async function GET(request: Request, { params }: { params: Promise<{ team: string }> }) {
  const { team: rawTeam } = await params;
  if (!/^\d{1,6}$/.test(rawTeam)) return Response.json({ error: "Invalid team number" }, { status: 400 });
  const teamNumber = Number(rawTeam);
  const year = Number(new URL(request.url).searchParams.get("year") ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 1992 || year > new Date().getFullYear() + 1) return Response.json({ error: "Invalid season year" }, { status: 400 });

  const cacheKey = `cache:insights:team-match-analysis:${teamNumber}:${year}`;
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const liveMatchKey = new URL(request.url).searchParams.get("liveMatchKey");
  const cached = refresh ? null : await redis.get(cacheKey);
  if (cached) {
    try { return Response.json(JSON.parse(cached)); } catch { await redis.del(cacheKey); }
  }

  try {
    const [rawEvents, statboticsMatches] = await Promise.all([
      TBA.getTeamEvents(`frc${teamNumber}`, year),
      Statbotics.getMatches({ team: teamNumber, year }).catch((error) => {
        console.warn("[Insights] bulk Statbotics team-match request failed", teamNumber, year, error);
        return [];
      }),
    ]);
    const events = rawEvents
      .filter((event) => event.event_type !== 99 && event.event_type !== 100)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
    const statboticsByMatch = new Map(statboticsMatches.flatMap((record) =>
      typeof record.key === "string" ? [[record.key, record] as const] : [],
    ));
    if (liveMatchKey) {
      try {
        const liveRecord = await Statbotics.getMatch(liveMatchKey, { refresh: true });
        if (liveRecord) statboticsByMatch.set(liveMatchKey, liveRecord);
      } catch { /* retain the bulk record */ }
    }
    const eventMatches = await withConcurrency(events, 4, async (event) => ({
      event,
      matches: sortMatches(await TBA.getTeamMatches(`frc${teamNumber}`, event.key)),
    }));
    const allMatches = eventMatches.flatMap(({ event, matches }) => matches.map((match) => ({ event, match })));
    const rows: (TeamMatchRow | null)[] = await withConcurrency(allMatches, 2, async ({ event, match }) => {
      const statbotics: StatboticsMatch | null = statboticsByMatch.get(match.key) ?? null;
      const red = match.alliances.red.team_keys ?? [];
      const blue = match.alliances.blue.team_keys ?? [];
      const alliance = red.includes(`frc${teamNumber}`) ? "red" : blue.includes(`frc${teamNumber}`) ? "blue" : null;
      if (!alliance) return null;
      const own = match.alliances[alliance];
      const otherColor = alliance === "red" ? "blue" : "red";
      const other = match.alliances[otherColor];
      const predicted = finite(alliance === "red" ? statbotics?.pred?.red_score : statbotics?.pred?.blue_score);
      const opponentPredicted = finite(alliance === "red" ? statbotics?.pred?.blue_score : statbotics?.pred?.red_score);
      const actual = finite(own.score) !== null && own.score >= 0 ? own.score : null;
      const opponentActual = finite(other.score) !== null && other.score >= 0 ? other.score : null;
      const redProbability = finite(statbotics?.pred?.red_win_prob);
      const teamProbability = redProbability === null ? null : alliance === "red" ? redProbability : 1 - redProbability;
      const scoreBreakdown = match.score_breakdown as unknown as Record<string, Record<string, unknown>> | null;
      const actualRP = scoreBreakdown?.[alliance] ?? {};
      const rpKeys = [{ key: "energized", prediction: alliance === "red" ? statbotics?.pred?.red_energized_rp : statbotics?.pred?.blue_energized_rp, actual: actualRP.energizedAchieved }, { key: "supercharged", prediction: alliance === "red" ? statbotics?.pred?.red_supercharged_rp : statbotics?.pred?.blue_supercharged_rp, actual: actualRP.superchargedAchieved }, { key: "traversal", prediction: alliance === "red" ? statbotics?.pred?.red_traversal_rp : statbotics?.pred?.blue_traversal_rp, actual: actualRP.traversalAchieved }];
      const rpOutcomes = rpKeys.map((item) => ({ key: item.key, predicted: finite(item.prediction), achieved: typeof item.actual === "boolean" ? item.actual : null }));
      const pre = teamEPA(statbotics, teamNumber, "pre_epas");
      const post = teamEPA(statbotics, teamNumber, "epas");
      const preEPA = finite(pre?.epa);
      const postEPA = finite(post?.epa);
      const alliancePreValues = own.team_keys.map((key) => finite(statbotics?.pre_epas?.[String(Number(key.replace(/^frc/i, "")))]?.epa));
      const alliancePreEPATotal = alliancePreValues.every((value) => value !== null) ? alliancePreValues.reduce<number>((sum,value)=>sum+(value??0),0) : null;
      const opponentPreValues = other.team_keys.map((key) => finite(statbotics?.pre_epas?.[String(Number(key.replace(/^frc/i, "")))]?.epa));
      const opponentPreEPATotal = opponentPreValues.every((value) => value !== null) ? opponentPreValues.reduce<number>((sum,value)=>sum+(value??0),0) : null;
      const componentKeys = ["auto_epa","teleop_epa","endgame_epa","rp_1_epa","rp_2_epa","rp_3_epa","tiebreaker_epa"];
      const alliancePreComponents: Record<string, number> = {};
      for (const key of componentKeys) {
        const values = own.team_keys.map((teamKey) => finite(statbotics?.pre_epas?.[String(Number(teamKey.replace(/^frc/i, "")))]?.[key as keyof StatboticsEPA]));
        if (values.every((value) => value !== null)) alliancePreComponents[key] = values.reduce<number>((sum,value)=>sum+(value??0),0);
      }
      const actualComponents: Record<string, number> = {};
      const autoField = Object.keys(actualRP).find((field) => /^(total)?auto(points)?$/i.test(field.replace(/[_\s-]/g, "")) && typeof actualRP[field] === "number");
      const teleopField = Object.keys(actualRP).find((field) => /^(total)?teleop(points)?$/i.test(field.replace(/[_\s-]/g, "")) && typeof actualRP[field] === "number");
      if (autoField) actualComponents.auto = actualRP[autoField] as number;
      // TBA score-breakdown schemas do not provide a dependable, consistent
      // endgame total. Keep teleop intact; infer endgame from Statbotics EPA.
      if (teleopField) actualComponents.teleop = actualRP[teleopField] as number;
      const foulField = Object.keys(actualRP).find((field) => /^foul(points)?$/i.test(field.replace(/[_\s-]/g, "")) && typeof actualRP[field] === "number");
      if (foulField) actualComponents.fouls = actualRP[foulField] as number;
      const deltaEPA = preEPA !== null && postEPA !== null ? postEPA - preEPA : null;
      const allianceDeltas = own.team_keys.map((key) => {
        const id = Number(key.replace(/^frc/i, ""));
        const before = finite(teamEPA(statbotics, id, "pre_epas")?.epa);
        const after = finite(teamEPA(statbotics, id, "epas")?.epa);
        return before !== null && after !== null ? after - before : null;
      }).filter((value): value is number => value !== null);
      const spread = allianceDeltas.length === own.team_keys.length && allianceDeltas.length > 1
        ? Math.max(...allianceDeltas) - Math.min(...allianceDeltas)
        : null;
      return {
        matchKey: match.key, matchLabel: label(match, event.playoff_type), compLevel: match.comp_level,
        event: { key: event.key, name: event.name, shortName: event.event_code, startDate: event.start_date },
        partners: own.team_keys.filter((key) => key !== `frc${teamNumber}`).map((key) => key.replace(/^frc/i, "")),
        opponents: other.team_keys.map((key) => key.replace(/^frc/i, "")),
        alliance, predicted, actual, residual: predicted !== null && actual !== null ? actual - predicted : null,
        opponentPredicted, opponentActual, opponentResidual: opponentPredicted !== null && opponentActual !== null ? opponentActual-opponentPredicted : null, alliancePreEPATotal, opponentPreEPATotal, alliancePreComponents, actualComponents, redWinProbability: redProbability, teamWinProbability: teamProbability, rpOutcomes,
        won: match.winning_alliance === "red" || match.winning_alliance === "blue" ? match.winning_alliance === alliance : null,
        preEPA, postEPA, deltaEPA, preComponents: components(pre), postComponents: components(post),
        allianceDeltaSpread: spread, sharedAllianceUpdate: spread !== null && spread < 0.000001,
        statboticsAvailable: statbotics !== null,
      } satisfies TeamMatchRow;
    });
    const completed = rows.filter((row): row is TeamMatchRow => row !== null && row.actual !== null && row.opponentActual !== null);
    const summarize = (items: TeamMatchRow[]) => {
      const scored = items.filter((row) => row.residual !== null);
      const residuals = scored.map((row) => row.residual as number);
      const wins = items.filter((row) => row.won === true).length;
      const decisions = items.filter((row) => row.won !== null).length;
      const ties = items.filter((row) => row.won === null && row.actual === row.opponentActual).length;
      const deltas = items.flatMap((row) => row.deltaEPA === null ? [] : [row.deltaEPA]);
      const rp = ["energized","supercharged","traversal"].map((key) => { const samples=items.flatMap((row)=>row.rpOutcomes.filter((item)=>item.key===key&&item.predicted!==null&&item.achieved!==null).map((item)=>({p:item.predicted as number,y:item.achieved?1:0}))); return {key,sampleSize:samples.length,accuracy:samples.length?samples.filter((item)=>(item.p>=0.5?1:0)===item.y).length/samples.length:null,brier:samples.length?samples.reduce((sum,item)=>sum+(item.p-item.y)**2,0)/samples.length:null}; });
      return {
        matches: items.length, wins, losses: decisions - wins, ties,
        winRate: decisions ? wins / decisions : null,
        meanResidual: residuals.length ? residuals.reduce((sum, value) => sum + value, 0) / residuals.length : null,
        meanAbsoluteError: residuals.length ? residuals.reduce((sum, value) => sum + Math.abs(value), 0) / residuals.length : null,
        rootMeanSquareError: residuals.length ? Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length) : null,
        meanMatchEPAChange: deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null,
        rp, epaStart: items.find((row) => row.preEPA !== null)?.preEPA ?? null,
        epaEnd: [...items].reverse().find((row) => row.postEPA !== null)?.postEPA ?? null,
      };
    };
    const eventSummaries = events.map((event) => {
      const items = completed.filter((row) => row.event.key === event.key);
      return { event: { key: event.key, name: event.name, shortName: event.event_code, startDate: event.start_date }, ...summarize(items) };
    }).filter((event) => event.matches > 0);
    const phaseSummaries = ["qm", "ef", "qf", "sf", "f"].map((phase) => ({
      phase, ...summarize(completed.filter((row) => row.compLevel === phase)),
    })).filter((item) => item.matches > 0);
    // Event-level shifts prevent events with longer playoff schedules from dominating.
    const eliminationByEvent = new Map<string, { event: TeamMatchRow["event"]; qualification: number[]; elimination: number[]; qualificationMatches: string[]; eliminationMatches: string[] }>();
    for (const row of completed) {
      if (row.residual === null) continue;
      let group = eliminationByEvent.get(row.event.key);
      if (!group) {
        group = { event: row.event, qualification: [], elimination: [], qualificationMatches: [], eliminationMatches: [] };
        eliminationByEvent.set(row.event.key, group);
      }
      if (row.compLevel === "qm") { group.qualification.push(row.residual); group.qualificationMatches.push(row.matchKey); }
      else if (["ef", "qf", "sf", "f"].includes(row.compLevel)) { group.elimination.push(row.residual); group.eliminationMatches.push(row.matchKey); }
    }
    const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const median = (values: number[]) => {
      if (!values.length) return null;
      const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    const eligibleEliminationEvents = [...eliminationByEvent.values()]
      .filter((item) => item.qualification.length >= 3 && item.elimination.length >= 2)
      .sort((a, b) => a.event.startDate.localeCompare(b.event.startDate))
      .map((item) => ({
        event: item.event, qualificationMatches: item.qualification.length, eliminationMatches: item.elimination.length,
        qualificationMeanResidual: average(item.qualification), eliminationMeanResidual: average(item.elimination),
        shift: (average(item.elimination) ?? 0) - (average(item.qualification) ?? 0),
        shiftStandardError: Math.sqrt((item.qualification.reduce((sum,value)=>sum+(value-(average(item.qualification)??0))**2,0)/Math.max(1,item.qualification.length-1))/item.qualification.length + (item.elimination.reduce((sum,value)=>sum+(value-(average(item.elimination)??0))**2,0)/Math.max(1,item.elimination.length-1))/item.elimination.length),
        qualificationMatchKeys: item.qualificationMatches, eliminationMatchKeys: item.eliminationMatches,
      }));
    const eventShifts = eligibleEliminationEvents.map((item) => item.shift);
    const negativeEventCount = eventShifts.filter((value) => value < 0).length;
    // The "after strong qualifications" test only includes events where the
    // team's qualification alliance residual was positive (above prediction).
    const positiveQualificationEvents = eligibleEliminationEvents.filter((item) => (item.qualificationMeanResidual ?? 0) > 0);
    const negativeShiftAfterPositiveQualCount = positiveQualificationEvents.filter((item) => item.shift < -item.shiftStandardError).length;
    const nPositiveQualificationEvents = positiveQualificationEvents.length;
    // Exact one-sided sign test: probability of at least this many negative shifts under p=0.5.
    const binomialCoefficient = (n: number, k: number) => {
      let value = 1;
      for (let i = 1; i <= k; i++) value = value * (n - i + 1) / i;
      return value;
    };
    const signTestPValue = nPositiveQualificationEvents ? Array.from({ length: nPositiveQualificationEvents - negativeShiftAfterPositiveQualCount + 1 }, (_, index) => negativeShiftAfterPositiveQualCount + index)
      .reduce((sum, successes) => sum + binomialCoefficient(nPositiveQualificationEvents, successes) / (2 ** nPositiveQualificationEvents), 0) : null;
    const eliminationMatchCount = rows.filter((row): row is TeamMatchRow => row !== null && ["ef", "qf", "sf", "f"].includes(row.compLevel)).length;
    const eliminationShift = {
      eliminationMatchCount, eligibleEventCount: eligibleEliminationEvents.length, negativeEventCount,
      positiveQualificationEventCount: nPositiveQualificationEvents, negativeShiftAfterPositiveQualCount,
      meanShift: average(eventShifts), medianShift: median(eventShifts),
      signTestPValue, minimumQualificationMatchesPerEvent: 3, minimumEliminationMatchesPerEvent: 2,
      events: eligibleEliminationEvents,
      interpretation: eliminationMatchCount === 0 ? "no-elimination-matches" as const
        : eligibleEliminationEvents.length === 0 ? "insufficient-history" as const
        : eligibleEliminationEvents.length === 1 ? "single-event-shift" as const
        : nPositiveQualificationEvents >= 3 && signTestPValue !== null && signTestPValue <= 0.05 && negativeShiftAfterPositiveQualCount >= 3 ? "recurring-negative-shift" as const
        : "no-established-negative-shift" as const,
    };
    const residualPatternDiagnostics = eventMatches.map(({ event }) => {
      const eventRows = rows.filter((row): row is TeamMatchRow => row !== null && row.event.key === event.key);
      const scoredRows = eventRows.filter((row) => row.actual !== null && row.opponentActual !== null);
      const items = scoredRows.filter((row) => row.residual !== null);
      const opponentResidualSamples = scoredRows.filter((row) => row.opponentResidual !== null).length;
      const strengthRatedSamples = items.filter((row) => row.opponentResidual !== null && row.alliancePreEPATotal !== null && row.opponentPreEPATotal !== null).length;
      const baseline = items.flatMap((row) => row.opponentResidual !== null && row.alliancePreEPATotal !== null && row.opponentPreEPATotal !== null && Math.abs(row.opponentPreEPATotal-row.alliancePreEPATotal) <= Math.max(5, Math.abs(row.alliancePreEPATotal)*0.2) ? [row.opponentResidual] : []);
      return { event: { key: event.key, name: event.name, shortName: event.event_code, startDate: event.start_date }, matches: eventRows.length, scoredMatches: scoredRows.length, teamResidualSamples: items.length, opponentResidualSamples, strengthRatedSamples, baselineAllianceSamples: baseline.length, eligible: items.length >= 3 && baseline.length >= 2 };
    });
    const residualPatternEvents = eventMatches.flatMap(({ event }) => {
      const items = completed.filter((row) => row.event.key === event.key && row.residual !== null);
      const baseline = items.flatMap((row) => row.opponentResidual !== null && row.alliancePreEPATotal !== null && row.opponentPreEPATotal !== null && Math.abs(row.opponentPreEPATotal-row.alliancePreEPATotal) <= Math.max(5, Math.abs(row.alliancePreEPATotal)*0.2) ? [row.opponentResidual] : []);
      if (items.length < 3 || baseline.length < 2) return [];
      const baselineMean = average(baseline) ?? 0;
      const baselineSd = Math.sqrt(baseline.reduce((sum, value) => sum + (value - baselineMean) ** 2, 0) / baseline.length);
      const teamMean = average(items.map((row) => row.residual as number)) ?? 0;
      return [{
        event: items[0].event, teamMatches: items.length, baselineAllianceSamples: baseline.length,
        teamMeanResidual: teamMean, baselineMeanResidual: baselineMean, baselineStandardDeviation: baselineSd,
        belowOneSigma: items.filter((row) => row.residual! < baselineMean - baselineSd).length,
        aboveOneSigma: items.filter((row) => row.residual! > baselineMean + baselineSd).length,
        belowBaseline: teamMean < baselineMean, matchKeys: items.map((row) => row.matchKey),
      }];
    });
    const negativeResidualEventCount = residualPatternEvents.filter((item) => item.belowBaseline).length;
    const residualEventCount = residualPatternEvents.length;
    const signTail = (n: number, successes: number) => Array.from({ length: n - successes + 1 }, (_, index) => successes + index)
      .reduce((sum, value) => sum + binomialCoefficient(n, value) / (2 ** n), 0);
    const positiveResidualEventCount = residualEventCount - negativeResidualEventCount;
    const residualSignPValue = residualEventCount ? signTail(residualEventCount, negativeResidualEventCount) : null;
    const positiveResidualSignPValue = residualEventCount ? signTail(residualEventCount, positiveResidualEventCount) : null;
    const residualPattern = {
      eligibleEventCount: residualEventCount, negativeEventCount: negativeResidualEventCount, positiveEventCount: positiveResidualEventCount,
      meanTeamResidual: average(residualPatternEvents.map((item) => item.teamMeanResidual - item.baselineMeanResidual)),
      signTestPValue: residualSignPValue, positiveSignTestPValue: positiveResidualSignPValue,
      interpretation: residualEventCount === 0 ? "insufficient-history" as const
        : residualEventCount === 1 && negativeResidualEventCount === 1 ? "single-event-below-baseline" as const
        : residualEventCount === 1 ? "single-event-above-baseline" as const
        : residualSignPValue !== null && residualSignPValue <= 0.05 && negativeResidualEventCount >= 3 ? "recurring-below-baseline" as const
        : positiveResidualSignPValue !== null && positiveResidualSignPValue <= 0.05 && positiveResidualEventCount >= 3 ? "recurring-above-baseline" as const
        : "no-established-pattern" as const,
      events: residualPatternEvents, diagnostics: residualPatternDiagnostics,
    };

    const medianOf = (values: number[]) => {
      if (!values.length) return null;
      const sorted = [...values].sort((a,b)=>a-b), middle = Math.floor(sorted.length/2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
    };
    const teamResiduals = completed.flatMap((row)=>row.residual===null?[]:[row.residual]);
    const opponentResiduals = completed.flatMap((row)=>row.opponentResidual===null?[]:[row.opponentResidual]);
    const teamMedian = medianOf(teamResiduals);
    const teamMad = medianOf(teamResiduals.flatMap((value)=>teamMedian===null?[]:[Math.abs(value-teamMedian)])) ?? 0;
    const opponentMedian = medianOf(opponentResiduals);
    const opponentMad = medianOf(opponentResiduals.flatMap((value)=>opponentMedian===null?[]:[Math.abs(value-opponentMedian)])) ?? 0;
    const teamOutlierBand = Math.max(25, 3 * 1.4826 * teamMad);
    const opponentOutlierBand = Math.max(25, 3 * 1.4826 * opponentMad);
    const teamAnomalies = completed.flatMap((row) => {
      const reasons: string[] = [];
      const kinds: string[] = [];
      if (teamResiduals.length >= 4 && row.residual !== null && teamMedian !== null && Math.abs(row.residual-teamMedian)>teamOutlierBand) {
        kinds.push(row.residual<0?"alliance-underperformance":"alliance-overperformance");
        reasons.push(`Alliance residual ${row.residual>0?"+":""}${row.residual.toFixed(1)} pts was ${Math.abs(row.residual-teamMedian).toFixed(1)} pts from this team's season median.`);
      }
      if (opponentResiduals.length >= 4 && row.opponentResidual !== null && opponentMedian !== null && Math.abs(row.opponentResidual-opponentMedian)>opponentOutlierBand) {
        kinds.push("opponent-anomaly");
        reasons.push(`Opponent alliance residual ${row.opponentResidual>0?"+":""}${row.opponentResidual.toFixed(1)} pts was unusual in this team's season match sample.`);
      }
      if (row.teamWinProbability !== null && row.teamWinProbability >= 0.8 && row.won === false) {
        kinds.push("high-confidence-loss");
        reasons.push(`Model assigned this team's alliance a ${Math.round(row.teamWinProbability*100)}% win probability, but it lost.`);
      }
      if (!reasons.length) return [];
      return [{matchKey:row.matchKey,matchLabel:row.matchLabel,event:row.event,compLevel:row.compLevel,
        partners:row.partners,opponents:row.opponents,alliance:row.alliance,residual:row.residual,
        opponentResidual:row.opponentResidual,teamWinProbability:row.teamWinProbability,won:row.won,
        kinds,reasons,highConfidenceMiss:kinds.includes("high-confidence-loss")}];
    });
    const evaluatedTeamMatches = completed.filter((row)=>row.residual!==null||row.opponentResidual!==null||(row.teamWinProbability!==null&&row.won!==null)).length;
    const anomalySummary = {
      matchesWithAnomalies: teamAnomalies.length, matchesEvaluated: evaluatedTeamMatches,
      frequency: evaluatedTeamMatches ? teamAnomalies.length/evaluatedTeamMatches : null,
      allianceUnderperformance: teamAnomalies.filter((item)=>item.kinds.includes("alliance-underperformance")).length,
      allianceOverperformance: teamAnomalies.filter((item)=>item.kinds.includes("alliance-overperformance")).length,
      opponentAnomalies: teamAnomalies.filter((item)=>item.kinds.includes("opponent-anomaly")).length,
      highConfidenceMisses: teamAnomalies.filter((item)=>item.highConfidenceMiss).length,
      baseline: "Season median and median absolute deviation; minimum 4 scored observations per side. Flags describe matches involving this team, not individual robot causation.",
    };
    const payload = {
      team: teamNumber, year, eventCount: events.length, matchCount: completed.length,
      summary: summarize(completed), eventSummaries, phaseSummaries, eliminationShift, residualPattern, anomalySummary, anomalies: teamAnomalies, matches: completed,
      collection: { state: completed.every((row) => row.statboticsAvailable) ? "complete" : "partial", statboticsMatches: completed.filter((row) => row.statboticsAvailable).length, totalMatches: completed.length, updatedAt: Date.now() },
    };
    await redis.set(cacheKey, JSON.stringify(payload), "EX", 60);
    return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[Insights] team match analysis failed", teamNumber, year, error);
    return Response.json({ error: "Team match analysis is temporarily unavailable" }, { status: 502 });
  }
}
