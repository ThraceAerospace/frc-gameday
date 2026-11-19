import type { FieldViewTeamAnalytics, FieldViewTeamMatchEvidence } from "@fieldview/domain";
import { getCanonicalEventSnapshot, getCanonicalTeamSnapshot } from "@/lib/events/serverSnapshot";

type TeamEventReference = {
  key: string;
  name: string;
  event_code?: string | null;
  start_date: string;
  event_type?: number;
};


type SeasonMatchEvidence = FieldViewTeamMatchEvidence & {
  event: { key: string; name: string; shortName: string | null; startDate: string };
};

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function signTail(n: number, negative: number): number | null {
  if (!n) return null;
  let total = 0;
  for (let k = negative; k <= n; k++) {
    let coefficient = 1;
    for (let i = 1; i <= k; i++) coefficient = coefficient * (n - i + 1) / i;
    total += coefficient / 2 ** n;
  }
  return total;
}
function standardError(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values) ?? 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}
function summarizePhase(items: SeasonMatchEvidence[]) {
  const completed = items.filter((item) => item.actual_score !== null && item.opponent_actual_score !== null);
  const residuals = completed.flatMap((item) => item.score_residual === null ? [] : [item.score_residual]);
  const deltas = completed.flatMap((item) => item.epa_change === null ? [] : [item.epa_change]);
  const decisions = completed.filter((item) => item.won !== null);
  const wins = decisions.filter((item) => item.won === true).length;
  const losses = decisions.length - wins;
  const ties = completed.filter((item) => item.won === null && item.actual_score === item.opponent_actual_score).length;
  const first = [...items].sort((a, b) => a.event.startDate.localeCompare(b.event.startDate) || a.match_key.localeCompare(b.match_key, undefined, { numeric: true })).find((item) => item.pre_match_epa !== null);
  const last = [...items].sort((a, b) => b.event.startDate.localeCompare(a.event.startDate) || b.match_key.localeCompare(a.match_key, undefined, { numeric: true })).find((item) => item.post_match_epa !== null);
  return {
    matches: completed.length, predictionSamples: residuals.length, wins, losses, ties,
    winRate: decisions.length ? wins / decisions.length : null,
    meanResidual: average(residuals),
    meanAbsoluteError: average(residuals.map(Math.abs)),
    rootMeanSquareError: residuals.length ? Math.sqrt(average(residuals.map((value) => value * value)) ?? 0) : null,
    meanMatchEPAChange: average(deltas),
    epaStart: first?.pre_match_epa ?? null, epaEnd: last?.post_match_epa ?? null,
  };
}
function buildSeasonDiagnostics(rows: SeasonMatchEvidence[]) {
  const completed = rows.filter((row) => row.actual_score !== null && row.opponent_actual_score !== null);
  const phaseSummaries = ["qm", "ef", "qf", "sf", "f"].flatMap((phase) => {
    const items = completed.filter((row) => row.competition_level.toLowerCase() === phase);
    return items.length ? [{ phase, ...summarizePhase(items) }] : [];
  });
  const overall = summarizePhase(completed);
  const byEvent = new Map<string, SeasonMatchEvidence[]>();
  for (const row of completed) byEvent.set(row.event.key, [...(byEvent.get(row.event.key) ?? []), row]);
  const eliminationEvents = [...byEvent.values()].map((items) => {
    const qualifications = items.filter((item) => item.competition_level.toLowerCase() === "qm" && item.score_residual !== null);
    const eliminations = items.filter((item) => ["ef", "qf", "sf", "f"].includes(item.competition_level.toLowerCase()) && item.score_residual !== null);
    if (qualifications.length < 3 || eliminations.length < 2) return null;
    const qualificationResiduals = qualifications.map((item) => item.score_residual as number);
    const eliminationResiduals = eliminations.map((item) => item.score_residual as number);
    const qualificationMeanResidual = average(qualificationResiduals) as number;
    const eliminationMeanResidual = average(eliminationResiduals) as number;
    return {
      event: items[0].event, qualificationMatches: qualifications.length, eliminationMatches: eliminations.length,
      qualificationMeanResidual, eliminationMeanResidual,
      shift: eliminationMeanResidual - qualificationMeanResidual,
      shiftStandardError: Math.sqrt(standardError(qualificationResiduals) ** 2 + standardError(eliminationResiduals) ** 2),
      qualificationMatchKeys: qualifications.map((item) => item.match_key),
      eliminationMatchKeys: eliminations.map((item) => item.match_key),
    };
  }).filter((item): item is NonNullable<typeof item> => item !== null).sort((a, b) => a.event.startDate.localeCompare(b.event.startDate));
  const shifts = eliminationEvents.map((item) => item.shift);
  const negativeShiftCount = shifts.filter((value) => value < 0).length;
  const positiveShiftCount = shifts.filter((value) => value > 0).length;
  const directionalShiftCount = negativeShiftCount + positiveShiftCount;
  const eliminationMatchCount = rows.filter((row) => ["ef", "qf", "sf", "f"].includes(row.competition_level.toLowerCase())).length;
  const eliminationShift = {
    eliminationMatchCount, eligibleEventCount: eliminationEvents.length,
    negativeEventCount: negativeShiftCount, positiveEventCount: positiveShiftCount,
    directionalEventCount: directionalShiftCount,
    meanShift: average(shifts), medianShift: median(shifts),
    signTestPValue: signTail(directionalShiftCount, negativeShiftCount),
    minimumQualificationMatchesPerEvent: 3, minimumEliminationMatchesPerEvent: 2,
    interpretation: eliminationMatchCount === 0 ? "no-elimination-matches" as const
      : eliminationEvents.length === 0 ? "insufficient-history" as const
      : eliminationEvents.length === 1 ? "single-event-shift" as const
      : directionalShiftCount >= 3 && negativeShiftCount >= 3 && (signTail(directionalShiftCount, negativeShiftCount) ?? 1) <= 0.05
        ? "recurring-negative-shift" as const : "no-established-negative-shift" as const,
    events: eliminationEvents,
  };
  const residualPatternEvents = [...byEvent.values()].flatMap((items) => {
    const teamRows = items.filter((item) => item.score_residual !== null);
    const baseline = teamRows.flatMap((item) => item.opponent_score_residual === null ? [] : [item.opponent_score_residual]);
    if (!teamRows.length || !baseline.length) return [];
    const teamMeanResidual = average(teamRows.map((item) => item.score_residual as number)) as number;
    const baselineMeanResidual = average(baseline) as number;
    const baselineStandardDeviation = Math.sqrt(average(baseline.map((value) => (value - baselineMeanResidual) ** 2)) ?? 0);
    return [{
      event: items[0].event, teamMatches: teamRows.length, baselineAllianceSamples: baseline.length,
      teamMeanResidual, baselineMeanResidual, baselineStandardDeviation,
      belowOneSigma: teamRows.filter((item) => (item.score_residual as number) < baselineMeanResidual - baselineStandardDeviation).length,
      aboveOneSigma: teamRows.filter((item) => (item.score_residual as number) > baselineMeanResidual + baselineStandardDeviation).length,
      belowBaseline: teamMeanResidual < baselineMeanResidual,
      matchKeys: teamRows.map((item) => item.match_key),
    }];
  }).sort((a, b) => a.event.startDate.localeCompare(b.event.startDate));
  const negativeResidualEventCount = residualPatternEvents.filter((item) => item.belowBaseline).length;
  const positiveResidualEventCount = residualPatternEvents.length - negativeResidualEventCount;
  const residualPattern = {
    eligibleEventCount: residualPatternEvents.length,
    negativeEventCount: negativeResidualEventCount, positiveEventCount: positiveResidualEventCount,
    meanTeamResidual: average(residualPatternEvents.map((item) => item.teamMeanResidual - item.baselineMeanResidual)),
    signTestPValue: signTail(residualPatternEvents.length, negativeResidualEventCount),
    positiveSignTestPValue: signTail(residualPatternEvents.length, positiveResidualEventCount),
    interpretation: residualPatternEvents.length === 0 ? "insufficient-history" as const
      : residualPatternEvents.length === 1 && negativeResidualEventCount === 1 ? "single-event-below-baseline" as const
      : residualPatternEvents.length === 1 ? "single-event-above-baseline" as const
      : (signTail(residualPatternEvents.length, negativeResidualEventCount) ?? 1) <= 0.05 && negativeResidualEventCount >= 3
        ? "recurring-below-baseline" as const
      : (signTail(residualPatternEvents.length, positiveResidualEventCount) ?? 1) <= 0.05 && positiveResidualEventCount >= 3
        ? "recurring-above-baseline" as const : "no-established-pattern" as const,
    events: residualPatternEvents,
  };
  const teamResiduals = completed.flatMap((item) => item.score_residual === null ? [] : [item.score_residual]);
  const opponentResiduals = completed.flatMap((item) => item.opponent_score_residual === null ? [] : [item.opponent_score_residual]);
  const teamMedian = median(teamResiduals), opponentMedian = median(opponentResiduals);
  const mad = (values: number[], center: number | null) => center === null ? 0 : median(values.map((value) => Math.abs(value - center))) ?? 0;
  const teamBand = Math.max(25, 3 * 1.4826 * mad(teamResiduals, teamMedian));
  const opponentBand = Math.max(25, 3 * 1.4826 * mad(opponentResiduals, opponentMedian));
  const anomalies = completed.flatMap((row) => {
    const kinds: string[] = [], reasons: string[] = [];
    if (teamResiduals.length >= 4 && row.score_residual !== null && teamMedian !== null && Math.abs(row.score_residual - teamMedian) > teamBand) {
      kinds.push(row.score_residual < 0 ? "alliance-underperformance" : "alliance-overperformance");
      reasons.push(`Alliance residual ${row.score_residual > 0 ? "+" : ""}${row.score_residual.toFixed(1)} pts was unusual relative to this team's season median.`);
    }
    if (opponentResiduals.length >= 4 && row.opponent_score_residual !== null && opponentMedian !== null && Math.abs(row.opponent_score_residual - opponentMedian) > opponentBand) {
      kinds.push("opponent-anomaly");
      reasons.push(`Opponent alliance residual ${row.opponent_score_residual > 0 ? "+" : ""}${row.opponent_score_residual.toFixed(1)} pts was unusual in this team's season match sample.`);
    }
    if (row.win_probability !== null && row.win_probability >= 0.8 && row.won === false) {
      kinds.push("high-confidence-loss");
      reasons.push(`Model assigned this alliance a ${Math.round(row.win_probability * 100)}% win probability, but it lost.`);
    }
    return reasons.length ? [{ ...row, kinds, reasons, highConfidenceMiss: kinds.includes("high-confidence-loss") }] : [];
  });
  const evaluated = completed.filter((row) => row.score_residual !== null || row.opponent_score_residual !== null || (row.win_probability !== null && row.won !== null)).length;
  const anomalySummary = {
    matchesWithAnomalies: anomalies.length, matchesEvaluated: evaluated,
    frequency: evaluated ? anomalies.length / evaluated : null,
    allianceUnderperformance: anomalies.filter((item) => item.kinds.includes("alliance-underperformance")).length,
    allianceOverperformance: anomalies.filter((item) => item.kinds.includes("alliance-overperformance")).length,
    opponentAnomalies: anomalies.filter((item) => item.kinds.includes("opponent-anomaly")).length,
    highConfidenceMisses: anomalies.filter((item) => item.highConfidenceMiss).length,
    baseline: "Season median and median absolute deviation; minimum 4 scored observations per side. Flags describe matches involving this team, not individual robot causation.",
  };
  return { overall, phaseSummaries, eliminationShift, residualPattern, anomalySummary, anomalies };
}

export async function GET(request: Request, { params }: { params: Promise<{ team: string }> }) {
  const { team: rawTeam } = await params;
  if (!/^\d{1,6}$/.test(rawTeam)) return Response.json({ error: "Invalid team number" }, { status: 400 });

  const teamNumber = Number(rawTeam);
  const year = Number(new URL(request.url).searchParams.get("year") ?? new Date().getUTCFullYear());
  if (!Number.isInteger(year) || year < 1992 || year > new Date().getUTCFullYear() + 1) {
    return Response.json({ error: "Invalid season year" }, { status: 400 });
  }

  const canonical = await getCanonicalTeamSnapshot(`frc${teamNumber}`, year);
  if (!canonical) return Response.json({ error: "Canonical team snapshot unavailable" }, { status: 503 });

  if (canonical.snapshot.events === undefined || canonical.snapshot.events === null) {
    return Response.json({ error: "Team season event list is still being acquired" }, { status: 503 });
  }

  const events = canonical.snapshot.events
    .filter((event) => event.event_type !== 99 && event.event_type !== 100)
    .sort((a, b) => a.start_date.localeCompare(b.start_date)) as TeamEventReference[];

  const eventResults = await Promise.all(events.map(async (event) => {
    const response = await getCanonicalEventSnapshot(event.key);
    const snapshot = response?.snapshot;
    const teamState = snapshot?.team_states?.find((entry) => entry.team_key === `frc${teamNumber}`);
    const analytics = (teamState?.analytics ?? null) as FieldViewTeamAnalytics | null;
    return {
      event: {
        key: event.key,
        name: snapshot?.event?.name ?? event.name,
        shortName: snapshot?.event?.short_name ?? event.event_code ?? null,
        startDate: snapshot?.event?.start_date ?? event.start_date,
      },
      status: !snapshot ? "unavailable" as const
        : analytics ? "ready" as const : "pending" as const,
      analytics,
    };
  }));

  const seasonEvidence: SeasonMatchEvidence[] = eventResults.flatMap((entry) =>
    (entry.analytics?.match_evidence ?? []).map((match) => ({ ...match, event: entry.event })),
  );
  const diagnostics = buildSeasonDiagnostics(seasonEvidence);
  const ready = eventResults.filter((entry) => entry.analytics !== null);
  const completedMatches = ready.reduce((sum, entry) =>
    sum + (entry.analytics?.performance?.completed_matches ?? 0), 0);
  const matchesSeen = ready.reduce((sum, entry) =>
    sum + (entry.analytics?.performance?.matches_seen ?? 0), 0);

  return Response.json({
    team: teamNumber,
    year,
    eventCount: events.length,
    analyzedEventCount: ready.length,
    matchCount: completedMatches,
    matchesSeen,
    events: eventResults,
    summary: diagnostics.overall,
    phaseSummaries: diagnostics.phaseSummaries,
    eliminationShift: diagnostics.eliminationShift,
    residualPattern: diagnostics.residualPattern,
    anomalySummary: diagnostics.anomalySummary,
    anomalies: diagnostics.anomalies,
    collection: {
      state: ready.length === events.length ? "complete" : ready.length > 0 ? "partial" : "pending",
      analyzedEvents: ready.length,
      totalEvents: events.length,
      updatedAt: Date.now(),
    },
  }, { headers: { "Cache-Control": "private, no-store" } });
}
