"use client";

import Link from "next/link";
import { Fragment } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EventAnalyticsResponse, ReviewFinding, TeamAnalyticsRow, TeamInsight } from "@/lib/insights/types";
import { formatTeamNumber, matchShortName } from "@/lib/tba/formatters";
import type { StatboticsTeamEvent, StatboticsTeamYear } from "@/lib/statbotics/types";

type TeamSeasonHistory = { team: { nickname?: string | null; name?: string | null }; season: StatboticsTeamYear | null; events: { event: { key: string; name: string; short_name?: string | null; start_date: string; week?: number | null }; statbotics: StatboticsTeamEvent | null; status: "ready" | "unavailable" }[] };
type TeamMatchRow = { matchKey:string; matchLabel:string; compLevel:string; event:{key:string;name:string;shortName?:string|null;startDate:string}; partners:string[]; opponents:string[]; alliance:"red"|"blue"; predicted:number|null; actual:number|null; residual:number|null; opponentPredicted:number|null; opponentActual:number|null; opponentResidual:number|null; alliancePreEPATotal:number|null; alliancePreComponents:Record<string,number>; actualComponents:Record<string,number>; redWinProbability:number|null; teamWinProbability:number|null; rpOutcomes:{key:string;predicted:number|null;achieved:boolean|null}[]; won:boolean|null; preEPA:number|null; postEPA:number|null; deltaEPA:number|null; preComponents:Record<string,number>; postComponents:Record<string,number>; allianceDeltaSpread:number|null; sharedAllianceUpdate:boolean; statboticsAvailable:boolean } ;
type TeamMatchAnalysis = { team:number; year:number; eventCount:number; matchCount:number; anomalySummary:{matchesWithAnomalies:number;matchesEvaluated:number;frequency:number|null;allianceUnderperformance:number;allianceOverperformance:number;opponentAnomalies:number;highConfidenceMisses:number;baseline:string}; anomalies:{matchKey:string;matchLabel:string;event:{key:string;name:string;startDate:string};compLevel:string;partners:string[];opponents:string[];alliance:string;residual:number|null;opponentResidual:number|null;teamWinProbability:number|null;won:boolean|null;kinds:string[];reasons:string[];highConfidenceMiss:boolean}[]; summary:{matches:number;wins:number;losses:number;winRate:number|null;meanResidual:number|null;meanAbsoluteError:number|null;rootMeanSquareError:number|null;meanMatchEPAChange:number|null;epaStart:number|null;epaEnd:number|null;rp:{key:string;sampleSize:number;accuracy:number|null;brier:number|null}[]}; eventSummaries:{event:{key:string;name:string;shortName?:string|null;startDate:string};matches:number;wins:number;losses:number;winRate:number|null;meanResidual:number|null;meanAbsoluteError:number|null;rootMeanSquareError:number|null;meanMatchEPAChange:number|null;epaStart:number|null;epaEnd:number|null}[]; phaseSummaries:{phase:string;matches:number;wins:number;losses:number;winRate:number|null;meanResidual:number|null;meanAbsoluteError:number|null;rootMeanSquareError:number|null;meanMatchEPAChange:number|null;epaStart:number|null;epaEnd:number|null;rp:{key:string;sampleSize:number;accuracy:number|null;brier:number|null}[]}[];eliminationShift:{eligibleEventCount:number;negativeEventCount:number;positiveQualificationEventCount:number;negativeShiftAfterPositiveQualCount:number;meanShift:number|null;medianShift:number|null;signTestPValue:number|null;minimumQualificationMatchesPerEvent:number;minimumEliminationMatchesPerEvent:number;interpretation:"insufficient-history"|"recurring-negative-shift"|"no-established-negative-shift";events:{event:{key:string;name:string;shortName?:string|null;startDate:string};qualificationMatches:number;eliminationMatches:number;qualificationMeanResidual:number|null;eliminationMeanResidual:number|null;shift:number;shiftStandardError:number;qualificationMatchKeys:string[];eliminationMatchKeys:string[]}[]};residualPattern:{eligibleEventCount:number;negativeEventCount:number;positiveEventCount:number;meanTeamResidual:number|null;signTestPValue:number|null;positiveSignTestPValue:number|null;interpretation:"insufficient-history"|"recurring-below-baseline"|"recurring-above-baseline"|"no-established-pattern";events:{event:{key:string;name:string;shortName?:string|null;startDate:string};teamMatches:number;baselineAllianceSamples:number;teamMeanResidual:number;baselineMeanResidual:number;baselineStandardDeviation:number;belowOneSigma:number;aboveOneSigma:number;belowBaseline:boolean;matchKeys:string[]}[]};matches:TeamMatchRow[];collection:{state:string;statboticsMatches:number;totalMatches:number;updatedAt:number}};
type Tab = "overview" | "teams" | "qualification" | "playoffs" | "matchup" | "scouting";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Event Overview" },
  { id: "teams", label: "Team Investigation" },
  { id: "qualification", label: "Qualification Analysis" },
  { id: "playoffs", label: "Playoff Analysis" },
  { id: "matchup", label: "Matchup Analysis" },
  { id: "scouting", label: "Scouting Tools" },
];
const fmt = (value: number | null | undefined, digits = 1) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
const percentileLabel = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}th`;

export default function EventAnalyticsDashboard({ eventKey, eventName, liveMatchKey, liveMatchSignature, websocketStatus, websocketStale }: { eventKey: string; eventName: string; liveMatchKey: string | null; liveMatchSignature: string; websocketStatus: "connected" | "disconnected" | "connecting"; websocketStale: boolean }) {
  const [data, setData] = useState<EventAnalyticsResponse | null>(null);
  const loadGeneration = useRef(0);
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [teamFocus, setTeamFocus] = useState("");
  const [teamA, setTeamA] = useState("");
  const [teamB, setTeamB] = useState("");
  const [historyA, setHistoryA] = useState<TeamSeasonHistory | null>(null);
  const [historyB, setHistoryB] = useState<TeamSeasonHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [matchAnalysisA, setMatchAnalysisA] = useState<TeamMatchAnalysis | null>(null);
  const [matchAnalysisB, setMatchAnalysisB] = useState<TeamMatchAnalysis | null>(null);
  const [matchAnalysisLoading, setMatchAnalysisLoading] = useState(false);
  const [matchAnalysisError, setMatchAnalysisError] = useState<string | null>(null);

  const load = useCallback(async (refreshMatchKey: string | null = null) => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const liveQuery = refreshMatchKey ? `?liveMatchKey=${encodeURIComponent(refreshMatchKey)}` : "";
      const response = await fetch(`/api/insights/event/${encodeURIComponent(eventKey)}${liveQuery}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      const next = await response.json() as EventAnalyticsResponse;
      if (generation === loadGeneration.current) setData(next);
    } catch (cause) {
      if (generation === loadGeneration.current) setError(cause instanceof Error ? cause.message : "Unable to load analytics");
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [eventKey]);

  useEffect(() => {
    void load(liveMatchKey);
    // The first response is the current snapshot; the server refresh runs in
    // waitUntil. Read the persisted result again shortly after a live change.
    if (!liveMatchKey) return;
    const timer = window.setTimeout(() => { void load(liveMatchKey); }, 2_500);
    return () => window.clearTimeout(timer);
  }, [load, liveMatchKey, liveMatchSignature]);

  useEffect(() => {
    if (!data) return;
    // WebSocket changes refresh immediately; this slower check reconciles
    // schedule and OPR updates that do not change the latest completed match.
    const cohortPending = data.seasonCohort && data.seasonCohort.state !== "complete" && data.seasonCohort.state !== "partial";
    const delay = data.collection.state === "complete" && !cohortPending ? 30_000 : 5_000;
    const timer = window.setTimeout(() => { void load(liveMatchKey); }, delay);
    return () => window.clearTimeout(timer);
  }, [data?.collection.state, data?.collection.processedMatchCount, data?.collection.updatedAt, data?.seasonCohort?.state, data?.seasonCohort?.updatedAt, load, liveMatchKey]);

  useEffect(() => {
    if (!teamA || !teamB) {
      setHistoryA(null);
      setHistoryB(null);
      return;
    }
    let active = true;
    setHistoryLoading(true);
    Promise.all([
      fetch(`/api/insights/team/${teamA}?year=${data?.event.year ?? new Date().getFullYear()}`, { cache: "no-store" }),
      fetch(`/api/insights/team/${teamB}?year=${data?.event.year ?? new Date().getFullYear()}`, { cache: "no-store" }),
    ]).then(async ([responseA, responseB]) => {
      if (!responseA.ok || !responseB.ok) throw new Error("Team season history is temporarily unavailable");
      const [nextA, nextB] = await Promise.all([responseA.json(), responseB.json()]);
      if (active) {
        setHistoryA(nextA as TeamSeasonHistory);
        setHistoryB(nextB as TeamSeasonHistory);
      }
    }).catch(() => {
      if (active) {
        setHistoryA(null);
        setHistoryB(null);
      }
    }).finally(() => {
      if (active) setHistoryLoading(false);
    });
    return () => { active = false; };
  }, [teamA, teamB, data?.event.year]);


  useEffect(() => {
    if (!teamA || !data?.event.year) {
      setMatchAnalysisA(null); setMatchAnalysisB(null); setMatchAnalysisError(null); return;
    }
    let active = true;
    setMatchAnalysisLoading(true); setMatchAnalysisError(null);
    const query = `year=${data.event.year}${liveMatchKey ? `&refresh=1&liveMatchKey=${encodeURIComponent(liveMatchKey)}` : ""}`;
    fetch(`/api/insights/team/${teamA}/matches?${query}`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("Team season investigation is temporarily unavailable");
      const result = await response.json();
      if (active) { setMatchAnalysisA(result as TeamMatchAnalysis); setMatchAnalysisB(null); }
    }).catch((error) => {
      if (active) { setMatchAnalysisA(null); setMatchAnalysisB(null); setMatchAnalysisError(error instanceof Error ? error.message : "Unable to load team investigation"); }
    }).finally(() => { if (active) setMatchAnalysisLoading(false); });
    return () => { active = false; };
  }, [teamA,data?.event.year,liveMatchKey,liveMatchSignature]);

  const teams = data?.teams ?? [];
  const selectedFocus = teams.find((team) => String(team.teamNumber) === teamFocus);
  const focusedInsight = data?.teamInsights?.find((item) => String(item.teamNumber) === teamFocus);
  const selectedA = teams.find((team) => String(team.teamNumber) === teamA);
  const selectedB = teams.find((team) => String(team.teamNumber) === teamB);
  const commonMatches = useMemo(() => data?.matches.filter((record) => {
    const keys = [...record.match.alliances.red.team_keys, ...record.match.alliances.blue.team_keys].map((key) => key.replace(/^frc/i, ""));
    return Boolean(teamA && teamB && keys.includes(teamA) && keys.includes(teamB));
  }) ?? [], [data?.matches, teamA, teamB]);
  const findings = data?.findings ?? [];
  const residuals = data?.allianceResults.filter((item) => item.residual !== null) ?? [];

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">FieldView · Event analytics</p>
          <h1 className="mt-1 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">{eventName}</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-500">Understand the competitive landscape: how teams compare, where the field is strongest, and which results have diverged from statistical expectations. Model outputs describe teams and alliances, not robot-specific observations.</p>
          <p className="mt-2 flex items-center gap-2 text-xs font-medium text-slate-500"><span className={`h-2 w-2 rounded-full ${websocketStatus === "connected" ? "bg-emerald-500" : websocketStatus === "connecting" ? "bg-amber-400" : "bg-slate-300"}`} />{websocketStatus === "connected" ? "Live event updates connected" : websocketStatus === "connecting" ? "Connecting to live event updates…" : "Live event updates disconnected"}{websocketStale ? " · Reconciliation pending" : ""}</p>
        </div>
        <Link href={`/event/${eventKey}`} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">Event details</Link>
      </div>

      <div className="sticky top-0 z-30 -mx-4 mb-4 border-b border-slate-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        {data ? (() => {
          const total = data.collection.totalMatchCount;
          const processed = data.collection.processedMatchCount;
          const unavailable = data.collection.unavailableMatchCount;
          const percent = total ? Math.round(processed / total * 100) : 100;
          return <div aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-slate-900">{data.collection.state === "complete" ? "Event analysis complete" : data.collection.state === "partial" ? "Event analysis has gaps" : "Building event analysis"}</p>
                <p className="mt-0.5 text-xs text-slate-600">{processed} of {total} matches processed · {unavailable} without a Statbotics match record</p>
              </div>
              <span className="text-sm font-semibold tabular-nums text-slate-700">{percent}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-blue-600 transition-[width] duration-500" style={{width:`${percent}%`}} /></div>
            {data.collection.statboticsFetchError ? <p className="mt-2 text-xs leading-5 text-amber-800">
              The bulk Statbotics request failed: {data.collection.statboticsFetchError}. TBA schedule and scores remain available. FieldView will retry the model-data request automatically; model-dependent metrics may be incomplete until it succeeds.
            </p> : unavailable > 0 ? <p className="mt-2 text-xs leading-5 text-amber-800">
              {unavailable} scheduled match(es) have no corresponding record in the Statbotics event collection. TBA match results are still retained. Statbotics may not have published predictions for these matches yet, or may not provide records for that match type. FieldView will reconcile the collection again as event data changes.
            </p> : null}
          </div>;
        })() : <div aria-live="polite">
          <p className="text-sm font-semibold text-slate-900">Loading event analytics</p>
          <p className="mt-0.5 text-xs text-slate-600">Retrieving the event schedule, teams, rankings, and available model records in parallel.</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full w-1/3 animate-pulse rounded-full bg-blue-600" /></div>
        </div>}
      </div>
      {error && <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
      {loading && !data ? <div className="mt-8 rounded-xl border border-slate-200 bg-white p-8 text-sm text-slate-500">Loading event analytics…</div> : null}
      {data ? <>
        <nav aria-label="Analytics views" className="no-scrollbar mt-6 flex gap-1 overflow-x-auto border-b border-slate-200">          {TABS.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`shrink-0 border-b-2 px-3 py-3 text-sm font-semibold ${tab === item.id ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>{item.label}</button>)}
        </nav>
        <div className="mt-5">
          {tab === "overview" && <EventOverview data={data} />}
          {tab === "teams" && <section className="space-y-4">
            <Panel title="Team investigation" description="Investigate one team at a time across its season: strength, match performance, development, peer-relative context, and unusual matches worth scouting.">
              <TeamSnapshot teams={teams} selectedTeam={teamA} onSelect={(value)=>{setTeamA(value);setTeamFocus(value);setTeamB("");}} team={selectedFocus} insight={focusedInsight ?? null}/>
              {matchAnalysisLoading ? <p className="mt-4 text-sm text-slate-500">Loading this team's season match history and model records…</p> : null}
              {matchAnalysisError ? <p role="alert" className="mt-4 text-sm text-rose-700">{matchAnalysisError}</p> : null}
              {matchAnalysisA ? <div className="mt-5 space-y-5">
                <TeamRiskPanel analysis={matchAnalysisA} />
                <div className="grid gap-4 xl:grid-cols-2">
                  <MatchAnalysisSummary analysis={matchAnalysisA} name={selectedA?.name ?? `Team ${teamA}`} />
                  <TeamEliminationSummary analysis={matchAnalysisA} />
                </div>
                <TeamMatchEpaLedger analysis={matchAnalysisA} name={selectedA?.name ?? `Team ${teamA}`} accent="blue"/>
              </div> : !matchAnalysisLoading && !matchAnalysisError && teamA ? <p className="mt-4 text-sm text-slate-500">No season match analysis is available yet.</p> : null}

            </Panel>
          </section>}
          {tab === "qualification" && <QualificationAnalysisPanel data={data} />}
          {tab === "playoffs" && <PlayoffAnalysisPanel data={data} />}
          {tab === "matchup" && <MatchupAnalysis data={data} />}
          {tab === "scouting" && <section className="space-y-4">
            <ReviewQueue findings={findings} />
            <details className="rounded-xl border border-slate-200 bg-white"><summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-700">Statistical diagnostics and alliance patterns</summary><div className="space-y-4 p-4">
              <Panel title="Unexpected alliance results" description="Alliance-level score differences from the Statbotics prediction. These are review context, not robot attribution."><ResidualBars residuals={residuals} /></Panel>
              <Panel title="Prediction quality" description="Event-specific score error and winner accuracy across available completed matches."><PredictionQuality stats={data.predictionStats} residualStats={data.residualStats} /></Panel>
              <Panel title="Repeated alliance patterns" description="Repeated three-team qualification combinations with notable average score residuals. These describe combinations, not individual team contribution."><AlliancePatterns findings={findings.filter((item) => item.category === "alliance-pattern")} /></Panel>
            </div></details>
          </section>}
        </div>
        <p className="mt-5 text-[11px] leading-5 text-slate-400">Sources: The Blue Alliance supplies event metadata, team rosters, match scores, score breakdowns, and OPR/DPR/CCWM. Statbotics data is supplied by the FieldView Statbotics mirror and includes model predictions and EPA estimates. Event-level model comparisons and alliance residuals are not robot-specific observations.</p>
      </> : null}
    </div>
  );
}
 



function TeamRiskPanel({analysis}:{analysis:TeamMatchAnalysis}) {
  const summary=analysis.anomalySummary;
  return <Panel title="Season match anomalies and scouting risks" description="Flags unusual outcomes in matches involving this team across its season. They identify where to investigate, not which robot caused an outcome.">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <QualityMetric label="Flagged matches" value={String(summary.matchesWithAnomalies)} detail={`of ${summary.matchesEvaluated} evaluated matches`} />
      <QualityMetric label="Anomaly frequency" value={summary.frequency===null?"—":`${(summary.frequency*100).toFixed(1)}%`} detail="Share of this team's evaluated matches" />
      <QualityMetric label="High-confidence misses" value={String(summary.highConfidenceMisses)} detail="Model win probability ≥80%, but alliance lost" />
      <QualityMetric label="Alliance underperformance" value={String(summary.allianceUnderperformance)} detail="Unusually negative score residuals" />
    </div>
    <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500"><span>{summary.allianceOverperformance} unusual overperformance</span><span>·</span><span>{summary.opponentAnomalies} unusual opponent results</span></div>
    <p className="mt-3 text-xs leading-5 text-slate-500">{summary.baseline}</p>
    {analysis.anomalies.length ? <div className="mt-4 space-y-3">{analysis.anomalies.map((item)=><article key={item.matchKey} className="rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-semibold text-slate-900">{item.matchLabel} · {item.event.name}</p><p className="text-xs text-slate-500">Partners {item.partners.join(" · ")||"—"} · Opponents {item.opponents.join(" · ")||"—"}</p></div><div className="flex flex-wrap gap-1">{item.kinds.map((kind)=><span key={kind} className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-800">{kind.replaceAll("-"," ")}</span>)}</div></div>
      <ul className="mt-2 space-y-1 text-sm text-slate-600">{item.reasons.map((reason)=><li key={reason}>{reason}</li>)}</ul>
      <a className="mt-2 inline-block text-xs font-semibold text-blue-700 hover:underline" href={`https://www.thebluealliance.com/match/${item.matchKey}`} target="_blank" rel="noreferrer">Inspect match on TBA ↗</a>
    </article>)}</div> : <p className="mt-4 text-sm text-slate-500">No matches have met the current anomaly criteria. This is not a guarantee that every match was routine.</p>}
  </Panel>;
}
function TeamEliminationSummary({analysis}:{analysis:TeamMatchAnalysis}) {
  const shift=analysis.eliminationShift;
  const label=shift.interpretation==="recurring-negative-shift"?"Recurring negative elimination shift":shift.interpretation==="insufficient-history"?"Insufficient elimination history":"No established recurring negative shift";
  return <Panel title="Elimination progression" description="Qualification-to-elimination changes are evaluated per event so long playoff schedules do not dominate the season result.">
    <p className="text-sm font-semibold text-slate-900">{label}</p>
    <div className="mt-3 grid grid-cols-2 gap-3"><QualityMetric label="Eligible events" value={String(shift.eligibleEventCount)} detail="≥3 scored quals and ≥2 scored elims" /><QualityMetric label="Negative shifts" value={String(shift.negativeEventCount)} detail="Elimination residual below qualification residual" /></div>
    <p className="mt-3 text-xs text-slate-500">Mean event shift: {fmt(shift.meanShift)} pts · median: {fmt(shift.medianShift)} pts · one-sided sign-test p: {fmt(shift.signTestPValue,3)}.</p>
    <p className="mt-2 text-xs text-slate-500">This is an exploratory alliance-level association, not proof of robot-level underperformance. Partner and opponent strength are not fully adjusted.</p>
    {shift.events.length ? <div className="mt-3 space-y-2">{shift.events.map((event)=><div key={event.event.key} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-xs"><span className="min-w-0 truncate">{event.event.name}</span><span className={event.shift<0?"font-semibold text-rose-700":"font-semibold text-emerald-700"}>{event.shift>0?"+":""}{fmt(event.shift)} pts</span></div>)}</div>:null}
  </Panel>;
}
function QualificationAnalysisPanel({data}:{data:EventAnalyticsResponse}) {
  const anomalies=data.qualificationAnomalies??[];
  return <section className="space-y-4">
    <Panel title="Qualification match anomalies" description="Find qualification matches where an alliance score fell outside the event-calibrated residual band or a high-confidence win prediction was wrong.">
      <p className="text-xs text-slate-500">Only qualification matches are included. The score band is estimated from observed event residuals; it is not a Statbotics-provided prediction interval. A flagged match is an investigation lead, not an explanation.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3"><QualityMetric label="Flagged alliance results" value={String(anomalies.length)} detail="Across the loaded qualification sample" /><QualityMetric label="High-confidence misses" value={String(anomalies.filter((item)=>item.highConfidenceMiss).length)} detail="At least 80% predicted win probability, but lost" /><QualityMetric label="Outside expected range" value={String(anomalies.filter((item)=>item.outsideExpectedRange).length)} detail="Residual outside empirical band" /></div>
      {anomalies.length ? <div className="mt-4 space-y-3">{anomalies.map((item)=><article key={item.id} className="rounded-lg border border-slate-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold text-slate-900">{item.matchLabel} · {item.alliance} alliance</h3><p className="text-xs text-slate-500">Teams {item.teamKeys.map((key)=>key.replace(/^frc/i,"")).join(" · ")}</p></div><span className={item.severity==="high"?"rounded-full bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700":"rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800"}>{item.severity} priority</span></div>
        <p className="mt-2 text-sm text-slate-700">Predicted {fmt(item.predicted)} · actual {fmt(item.actual)} · residual {item.residual>0?"+":""}{fmt(item.residual)} pts · win probability {item.winProbability===null?"—":`${Math.round(item.winProbability*100)}%`}</p>
        <ul className="mt-2 list-disc pl-5 text-sm text-slate-600">{item.reasons.map((reason)=><li key={reason}>{reason}</li>)}</ul>
        <a className="mt-2 inline-block text-xs font-semibold text-blue-700 hover:underline" href={`https://www.thebluealliance.com/match/${item.matchKey}`} target="_blank" rel="noreferrer">Inspect match on TBA ↗</a>
      </article>)}</div> : <p className="mt-4 text-sm text-slate-500">{data.matches.filter((item)=>item.match.comp_level==="qm"&&item.match.alliances.red.score>=0&&item.match.alliances.blue.score>=0).length<8?"Waiting for a larger completed qualification sample before flagging score outliers.":"No qualification anomalies met the current criteria in the loaded sample."}</p>}
    </Panel>
  </section>;
}
function PlayoffAnalysisPanel({data}:{data:EventAnalyticsResponse}) {
  const playoff = data.playoffAnalysis;
  const matchesByKey = new Map(data.matches.map(({match}) => [match.key, match]));
  return <section className="space-y-4">
    <Panel
      title="Playoff alliance performance"
      description="See how each official playoff alliance performed against Statbotics' pre-match score estimate. Positive residuals mean the alliance scored above prediction; negative residuals mean it scored below."
    >
      {!playoff || !playoff.matchCount ? (
        <p className="text-sm text-slate-500">No completed elimination matches with recorded scores are available in the current event data.</p>
      ) : <>
        <div className="grid gap-3 sm:grid-cols-2">
          <QualityMetric label="Completed playoff matches" value={String(playoff.matchCount)} detail="Matches with recorded alliance scores" />
          <QualityMetric label="Alliance groups" value={String(playoff.allianceCount)} detail="Distinct official alliances or observed team lineups" />
        </div>
        <div className="mt-4 space-y-3">
          {playoff.alliances.map((alliance) => {
            const residual = alliance.meanResidual;
            const residualTone = residual === null || residual === 0
              ? "text-slate-700"
              : residual > 0 ? "text-emerald-700" : "text-rose-700";
            const residualLabel = residual === null ? "Unavailable"
              : residual > 0 ? "Above prediction" : residual < 0 ? "Below prediction" : "On prediction";
            const record = `${alliance.wins}-${alliance.losses}-${alliance.ties}`;
            return <article key={alliance.name ? `name:${alliance.name}` : alliance.teamKeys.join("|")} className="rounded-xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{alliance.name ?? "Alliance name unavailable"}</p>
                  <h3 className="mt-1 text-base font-bold text-slate-900">Teams {alliance.teamKeys.map(formatTeamNumber).join(" · ")}</h3>
                  <p className="mt-1 text-xs text-slate-500">{alliance.matchCount} completed match{alliance.matchCount === 1 ? "" : "es"} · {alliance.scoredMatchCount} with score predictions</p>
                </div>
                <div className="shrink-0 rounded-lg bg-slate-50 px-3 py-2 text-right">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Playoff record</p>
                  <p className="text-lg font-bold tabular-nums text-slate-900">{record}</p>
                  <p className="text-[10px] text-slate-500">W–L–T{alliance.unknownOutcomes > 0 ? ` · ${alliance.unknownOutcomes} winner not recorded` : ""}</p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 border-y border-slate-100 py-3">
                <div>
                  <p className="text-[11px] text-slate-500">Avg. predicted</p>
                  <p className="mt-1 text-lg font-bold tabular-nums text-slate-900">{fmt(alliance.meanPredicted, 0)}</p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500">Avg. actual</p>
                  <p className="mt-1 text-lg font-bold tabular-nums text-slate-900">{fmt(alliance.meanActual, 0)}</p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500">Avg. residual</p>
                  <p className={`mt-1 text-lg font-bold tabular-nums ${residualTone}`}>{residual === null ? "—" : `${residual > 0 ? "+" : ""}${fmt(residual, 1)}`}</p>
                  <p className={`text-[10px] font-medium ${residualTone}`}>{residualLabel}</p>
                </div>
              </div>
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-semibold text-blue-700 hover:text-blue-800">
                  Match-by-match results ({alliance.matchCount})
                </summary>
                <div className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-100">
                  {alliance.matches.map((match) => {
                    const sourceMatch = matchesByKey.get(match.matchKey);
                    const label = sourceMatch ? matchShortName(sourceMatch, data.event.playoff_type) : "Match label unavailable";
                    const outcomeTone = match.outcome === "win" ? "text-emerald-700"
                      : match.outcome === "loss" ? "text-rose-700" : "text-slate-500";
                    return <a
                      key={match.matchKey}
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-xs hover:bg-slate-50"
                      href={`https://www.thebluealliance.com/match/${match.matchKey}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span className="font-semibold text-blue-700">{label} ↗</span>
                      <span className="tabular-nums text-slate-600">
                        Actual {fmt(match.actual, 0)} · Predicted {fmt(match.predicted, 0)}
                      </span>
                      <span className={`font-semibold tabular-nums ${match.residual === null ? "text-slate-500" : match.residual >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                        {match.residual === null ? "No prediction" : `${match.residual > 0 ? "+" : ""}${fmt(match.residual)} pts`}
                      </span>
                      <span className={`uppercase ${outcomeTone}`}>{match.outcome === "unknown" ? "Result unavailable" : match.outcome}</span>
                    </a>;
                  })}
                </div>
              </details>
            </article>;
          })}
        </div>
        <p className="text-xs leading-5 text-slate-500">
          Residual = actual score − predicted score. A positive average means the alliance outscored the model estimate; a negative average means it scored below it. These are alliance-level results, not evidence about an individual robot.
        </p>
      </>}
    </Panel>
  </section>;
}

function TeamSnapshot({teams,selectedTeam,onSelect,team,insight}:{teams:TeamAnalyticsRow[];selectedTeam:string;onSelect:(value:string)=>void;team:TeamAnalyticsRow|undefined;insight:TeamInsight|null}) {
  const points = insight?.epaTrend.filter((point): point is {matchKey:string;matchLabel:string;epa:number} => point.epa !== null) ?? [];
  const min = Math.min(...points.map((point)=>point.epa),0);
  const max = Math.max(...points.map((point)=>point.epa),1);
  const range = Math.max(1,max-min);
  const x = (index:number) => points.length < 2 ? 450 : 44 + index * 812 / (points.length - 1);
  const y = (value:number) => 208 - (value-min) / range * 168;
  const line = points.map((point,index)=>`${x(index)},${y(point.epa)}`).join(" ");
  return <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
    <div><p className="text-xs font-bold uppercase tracking-wide text-blue-700">Team analysis</p><h2 className="mt-1 text-lg font-bold text-slate-900">Team brief</h2><p className="mt-1 text-sm text-slate-500">Start with the main takeaways. Open the evidence only when you want the underlying numbers or match details.</p></div>
    <label className="mt-4 block max-w-md text-sm font-semibold text-slate-700">Choose a team
      <select value={selectedTeam} onChange={(event)=>onSelect(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2">
        <option value="">Choose a team…</option>
        {teams.map((item)=><option key={item.teamKey} value={String(item.teamNumber)}>{item.teamNumber} · {item.name}</option>)}
      </select>
    </label>
    {!selectedTeam ? <p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-600">Choose a team to see its event summary, comparison with its previous event, and matches worth reviewing.</p> : !team || !insight ? <p className="mt-4 text-sm text-slate-500">The team brief is still being assembled from the available event match sample.</p> : <>
      <div className="mt-5 flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Team {team.teamNumber}</p><h3 className="text-xl font-black text-slate-950">{team.name}</h3><p className="mt-1 text-xs text-slate-500">{insight.metrics.matchesSeen} appearances in the loaded event sample</p></div>
        <a href={`https://www.thebluealliance.com/team/${team.teamNumber}`} target="_blank" rel="noreferrer" className="text-xs font-semibold text-blue-700 hover:underline">Team history on TBA ↗</a>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        <QualityMetric label="Statbotics EPA" value={fmt(team.epa)} detail="Current team strength estimate"/>
        <QualityMetric label="Event percentile" value={team.epaPercentile===null?"—":`${Math.round(team.epaPercentile*100)}%`} detail="Relative to this event roster"/>
        <QualityMetric label="TBA OPR" value={fmt(team.opr)} detail="Offensive score contribution estimate"/>
        <QualityMetric label="TBA DPR" value={fmt(team.dpr)} detail="Defensive score contribution estimate"/>
        <QualityMetric label="TBA CCWM" value={fmt(team.ccwm)} detail="Calculated contribution to winning margin"/>
      </div>
      {insight.seasonComparison ? <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50/50 p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-blue-800">Compared with previous event</p>
        <p className="mt-1 text-sm font-semibold text-slate-900">EPA {fmt(insight.seasonComparison.priorEPA,1)} → {fmt(insight.seasonComparison.currentEPA,1)} ({insight.seasonComparison.change>0?"+":""}{fmt(insight.seasonComparison.change,1)} points)</p>
        <p className="mt-1 text-sm text-slate-700">This was the {insight.seasonComparison.cohortRank}{insight.seasonComparison.cohortRank===1?"st":insight.seasonComparison.cohortRank===2?"nd":insight.seasonComparison.cohortRank===3?"rd":"th"} largest change among {insight.seasonComparison.cohortSize} event teams with usable previous-event records.</p>
        <p className="mt-1 text-xs text-slate-500">Previous event: {insight.seasonComparison.priorEvent.name}. EPA is a model estimate, not a direct measurement of robot scoring.</p>
      </div> : null}
      <div className="mt-4">
        <h4 className="text-sm font-bold text-slate-900">What stands out</h4>
        <ul className="mt-2 space-y-3">{insight.summary.slice(0,3).map((item,index)=><li key={index} className="flex gap-3 text-sm leading-6 text-slate-700"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-600"/><span>{item}</span></li>)}</ul>
        {insight.summary.length>3 ? <details className="mt-3 rounded-lg border border-slate-200"><summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-600">More summary details</summary><ul className="space-y-2 px-4 pb-3 pt-1 text-sm text-slate-600">{insight.summary.slice(3).map((item,index)=><li key={index} className="list-disc ml-4">{item}</li>)}</ul></details> : null}
      </div>
      <div className="mt-4 rounded-lg border border-slate-200 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold text-slate-900">Performance against similarly rated alliances</h4><span className="text-xs text-slate-500">{insight.peerPerformance.teamMatches} team matches · {insight.peerPerformance.peerAllianceCount} peer alliance results</span></div>
        <p className="mt-2 text-sm text-slate-700">{insight.peerPerformance.interpretation==="insufficient-sample"?"Not enough comparable alliance results to establish a peer-relative pattern.":insight.peerPerformance.interpretation==="above-peers"?"Alliances involving this team have scored meaningfully above comparable-strength alliances.":insight.peerPerformance.interpretation==="below-peers"?"Alliances involving this team have scored meaningfully below comparable-strength alliances.":"Alliance results involving this team are broadly similar to comparable-strength alliances."}</p>
        <p className="mt-1 text-xs text-slate-500">Mean residual: {fmt(insight.peerPerformance.teamMeanResidual)} pts · peer mean: {fmt(insight.peerPerformance.peerMeanResidual)} pts · difference: {fmt(insight.peerPerformance.difference)} pts. Peers are other event alliances within ±20% pre-match combined EPA; this is alliance-level context, not robot attribution.</p>
      </div>
      <div className="mt-5 rounded-lg border border-slate-100 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-sm font-semibold text-slate-900">EPA trend during this event</h4><p className="text-xs text-slate-500">A supporting view of the model estimate across match appearances</p></div><span className="text-xs text-slate-500">{points.length} observations</span></div>
        {points.length>1 ? <svg viewBox="0 0 900 238" role="img" aria-label={`Team ${team.teamNumber} EPA progression during the event`} className="mt-2 w-full">
          {[0,1,2,3].map((n)=><g key={n}><line x1="42" x2="862" y1={34+n*54} y2={34+n*54} stroke="#e2e8f0" strokeDasharray="3 4"/><text x="34" y={38+n*54} textAnchor="end" fontSize="10" fill="#64748b">{(max-range*n/3).toFixed(0)}</text></g>)}
          <polyline points={line} fill="none" stroke="#2563eb" strokeWidth="2.5" strokeLinejoin="round"/>
          {points.map((point,index)=><circle key={point.matchKey} cx={x(index)} cy={y(point.epa)} r="4" fill="#2563eb"><title>{point.matchLabel}: {point.epa.toFixed(2)} EPA</title></circle>)}
          <text x="44" y="230" fontSize="10" fill="#64748b">{points[0].matchLabel}</text><text x="858" y="230" textAnchor="end" fontSize="10" fill="#64748b">{points[points.length-1].matchLabel}</text>
        </svg> : <p className="mt-3 text-sm text-slate-500">Not enough EPA observations to draw a progression yet.</p>}
      </div>
      <div className="mt-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-bold text-slate-900">Matches worth reviewing</h4><span className="text-xs text-slate-500">{insight.reviewMatches.length} signals · browser-local review state</span></div>
        <p className="mt-1 text-xs text-slate-500">These matches differed from model expectations or contained unusual alliance-level updates. The signal identifies where to look, not why the result happened.</p>
        {!insight.reviewMatches.length ? <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">No matches met the current review thresholds in the available sample.</p> : <div className="mt-3 space-y-2">{insight.reviewMatches.map((match)=><article key={match.matchKey} className="rounded-lg border border-amber-200 bg-amber-50/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-bold text-slate-900">{match.matchLabel} · {match.alliance.toUpperCase()} alliance</p><p className="mt-1 text-xs text-slate-500">Partners: {match.partners.join(" · ")||"—"} · Opponents: {match.opponents.join(" · ")||"—"}</p></div><a href={`https://www.thebluealliance.com/match/${match.matchKey}`} target="_blank" rel="noreferrer" className="text-xs font-semibold text-blue-700 hover:underline">Review match ↗</a></div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-700">{match.reasons.map((reason)=><li key={reason}>{reason}</li>)}</ul>
          <p className="mt-2 text-[11px] text-slate-500">Predicted {fmt(match.predicted)} · actual {fmt(match.actual,0)} · residual {match.residual===null?"—":`${match.residual>0?"+":""}${fmt(match.residual)}`} · EPA update {match.deltaEPA===null?"—":`${match.deltaEPA>0?"+":""}${fmt(match.deltaEPA,2)}`}</p>
        </article>)}</div>}
      </div>
      <details className="mt-4 rounded-lg border border-slate-200">
        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-600">Detailed team metrics and official-season history</summary>
        <div className="p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <HistoryMetric label="Event EPA" value={fmt(insight.metrics.epa,2)}/>
            <HistoryMetric label="Event percentile" value={insight.metrics.epaPercentile===null?"—":`${Math.round(insight.metrics.epaPercentile*100)}th`}/>
            <HistoryMetric label="Official rank" value={insight.metrics.rank===null?"—":String(insight.metrics.rank)}/>
            <HistoryMetric label="Matches represented" value={String(insight.metrics.matchesSeen)}/>
          </div>
          {insight.seasonHistory.length ? <div className="mt-4 overflow-x-auto"><h4 className="mb-2 text-sm font-semibold text-slate-800">Official-season event history</h4><table className="w-full min-w-[420px] text-xs"><thead><tr className="border-b text-left text-slate-400"><th className="py-2">Event</th><th>EPA total points</th><th>Matches</th><th>Data</th></tr></thead><tbody>{insight.seasonHistory.map((item)=><tr key={item.event.key} className="border-b border-slate-100"><th className="py-2 text-left font-medium"><a href={"https://www.thebluealliance.com/event/"+item.event.key} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">{item.event.name}</a></th><td className="tabular-nums">{fmt(item.epaTotal,2)}</td><td>{item.matches??"—"}</td><td>{item.status}</td></tr>)}</tbody></table><p className="mt-2 text-[11px] text-slate-500">Statbotics team-event EPA total-points snapshots, not measured robot scores.</p></div> : <p className="mt-3 text-sm text-slate-500">No official-season history records are available yet.</p>}
        </div>
      </details>
      <p className="mt-4 text-[11px] leading-5 text-slate-500">Interpretation boundary: EPA is a model estimate; an EPA update may be shared across alliance members. Score residuals and win-probability mismatches describe alliance/match outcomes. They are investigation prompts, not causal findings or robot-level attribution.</p>
    </>}
  </section>;
}

function EliminationShiftPanel({analysis}:{analysis:TeamMatchAnalysis}) {
  const result = analysis.eliminationShift;
  const recurring = result.interpretation === "recurring-negative-shift";
  const label = recurring ? "Recurring negative shift" : result.positiveQualificationEventCount < 3 ? "Insufficient history" : "No established negative shift";
  return <section className="mt-3 rounded-lg border border-slate-200 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h4 className="text-sm font-bold text-slate-900">Elimination performance shift</h4><p className="text-[11px] text-slate-500">Qualification-to-elimination change in alliance score residual, compared within each event</p></div>
      <span className={recurring ? "rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold uppercase text-amber-800" : "rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase text-slate-600"}>{label}</span>
    </div>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <HistoryMetric label="Mean event shift" value={result.meanShift===null?"—":(result.meanShift>0?"+":"")+fmt(result.meanShift)+" pts"}/>
      <HistoryMetric label="Median event shift" value={result.medianShift===null?"—":(result.medianShift>0?"+":"")+fmt(result.medianShift)+" pts"}/>
      <HistoryMetric label="Negative shifts after positive quals" value={result.negativeShiftAfterPositiveQualCount+" / "+result.positiveQualificationEventCount}/>
      <HistoryMetric label="Sign-test p-value" value={fmt(result.signTestPValue, 3)}/>
    </div>
    {result.events.length ? <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[520px] text-xs"><thead><tr className="border-b text-left text-slate-400"><th className="py-2">Event</th><th>Qual. n</th><th>Elim. n</th><th>Qual. residual</th><th>Elim. residual</th><th>Shift ± 1 SE</th><th>Match evidence</th></tr></thead><tbody>{result.events.map((item)=><tr key={item.event.key} className="border-b border-slate-100"><th className="py-2 text-left font-medium"><a className="text-blue-700 hover:underline" href={"https://www.thebluealliance.com/event/"+item.event.key} target="_blank" rel="noreferrer">{item.event.shortName??item.event.name}</a></th><td>{item.qualificationMatches}</td><td>{item.eliminationMatches}</td><td className="tabular-nums">{fmt(item.qualificationMeanResidual)}</td><td className="tabular-nums">{fmt(item.eliminationMeanResidual)}</td><td className={item.shift<0?"font-semibold tabular-nums text-rose-700":"font-semibold tabular-nums text-emerald-700"}>{item.shift>0?"+":""}{fmt(item.shift)} ± {fmt(item.shiftStandardError)}</td><td><div className="flex flex-wrap gap-1">{item.qualificationMatchKeys.map((key)=><a key={key} className="text-blue-700 hover:underline" href={"https://www.thebluealliance.com/match/"+key} target="_blank" rel="noreferrer" title="Qualification match">Q</a>)}<span className="text-slate-300">|</span>{item.eliminationMatchKeys.map((key)=><a key={key} className="font-semibold text-amber-700 hover:underline" href={"https://www.thebluealliance.com/match/"+key} target="_blank" rel="noreferrer" title="Elimination match">E</a>)}</div></td></tr>)}</tbody></table></div> : <p className="mt-3 text-xs text-slate-500">No event has at least 3 scored qualification matches and 2 scored elimination matches with usable predictions. More elimination history is needed.</p>}
    <p className="mt-3 text-[11px] leading-5 text-slate-500">A negative shift means the team's alliance residual was lower in eliminations than qualifications at the same event. The recurrence test counts only declines larger than one estimated standard error, and only after above-prediction qualification performance. The choking-oriented recurrence test only counts events where the qualification residual was positive (above prediction). The sign test measures whether negative shifts recur specifically after above-prediction qualification performances; it is not a causal test. This first-pass signal is unadjusted for partner and opponent strength, and alliance residuals cannot identify an individual robot's contribution. Treat small samples as exploratory, not as a team reputation.</p>
  </section>;
}
function ResidualPatternPanel({analysis}:{analysis:TeamMatchAnalysis}) {
  const result = analysis.residualPattern;
  const status = result.interpretation === "recurring-below-baseline" ? "Recurring below-baseline pattern"
    : result.interpretation === "recurring-above-baseline" ? "Recurring above-baseline pattern"
    : result.interpretation === "insufficient-history" ? "Insufficient history" : "No established pattern";
  return <section className="mt-3 rounded-lg border border-slate-200 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-sm font-bold text-slate-900">Recurring score residual pattern</h4><p className="text-[11px] text-slate-500">Team alliance residual compared with strength-matched opponent alliances in the same event</p></div><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase text-slate-600">{status}</span></div>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <HistoryMetric label="Eligible events" value={String(result.eligibleEventCount)}/>
      <HistoryMetric label="Below / above events" value={result.negativeEventCount+" / "+result.positiveEventCount}/>
      <HistoryMetric label="Mean residual gap" value={result.meanTeamResidual===null?"—":(result.meanTeamResidual>0?"+":"")+fmt(result.meanTeamResidual)+" pts"}/>
      <HistoryMetric label="Directional sign-test" value={result.signTestPValue===null?"—":result.signTestPValue.toFixed(3)}/>
    </div>
    {result.events.length ? <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[560px] text-xs"><thead><tr className="border-b text-left text-slate-400"><th className="py-2">Event</th><th>Matches</th><th>Team residual</th><th>Baseline</th><th>Below / above 1σ</th><th>Evidence</th></tr></thead><tbody>{result.events.map((item)=><tr key={item.event.key} className="border-b border-slate-100"><th className="py-2 text-left font-medium">{item.event.shortName??item.event.name}</th><td>{item.teamMatches}</td><td className="tabular-nums">{fmt(item.teamMeanResidual)}</td><td className="tabular-nums">{fmt(item.baselineMeanResidual)} ± {fmt(item.baselineStandardDeviation)}</td><td>{item.belowOneSigma} / {item.aboveOneSigma}</td><td><div className="flex flex-wrap gap-1">{item.matchKeys.map((key)=><a key={key} href={"https://www.thebluealliance.com/match/"+key} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">{key.split("_").pop()}</a>)}</div></td></tr>)}</tbody></table></div> : <p className="mt-3 text-xs text-slate-500">Need at least three scored team matches and six alliance residual samples in an event.</p>}
    <p className="mt-3 text-[11px] leading-5 text-slate-500">The baseline uses opposing alliances in matches featuring this team, matched within ±20% of the selected alliance pre-match combined EPA. It is an approximate event-specific peer sample, not a fully independent event-wide calibration. This signal cannot separate the selected team from its partners or opponents; it is a review prompt, not an attribution or causal conclusion.</p>
  </section>;
}
function MatchAnalysisSummary({analysis,name}:{analysis:TeamMatchAnalysis;name:string}) {
  const s=analysis.summary;
  return <section className="rounded-xl border border-slate-200 p-4">
    <div className="flex items-center justify-between gap-2"><h3 className="font-bold text-slate-900">{name}</h3><span className="text-xs text-slate-500">{analysis.matchCount} matches · {analysis.eventCount} events</span></div>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
      <HistoryMetric label="Match wins" value={`${s.wins}–${s.losses}`}/>
      <HistoryMetric label="Win rate" value={s.winRate===null?"—":`${(s.winRate*100).toFixed(1)}%`}/>
      <HistoryMetric label="Mean score error" value={fmt(s.meanAbsoluteError)}/>
      <HistoryMetric label="Prediction bias" value={s.meanResidual===null?"—":`${s.meanResidual>0?"+":""}${fmt(s.meanResidual)}`}/>
      <HistoryMetric label="Score RMSE" value={fmt(s.rootMeanSquareError)}/>
      <HistoryMetric label="EPA first → last" value={`${fmt(s.epaStart,2)} → ${fmt(s.epaEnd,2)}`}/>
    </div>
    <EliminationShiftPanel analysis={analysis} />
    <ResidualPatternPanel analysis={analysis} />
    <div className="mt-3 grid grid-cols-3 gap-2">{s.rp.map((item)=><div key={item.key} className="rounded-lg bg-slate-50 p-2"><p className="text-[10px] font-semibold uppercase text-slate-500">{item.key} RP</p><p className="text-sm font-bold text-slate-900">{item.accuracy===null?"—":`${(item.accuracy*100).toFixed(1)}%`}</p><p className="text-[10px] text-slate-500">Brier {fmt(item.brier,3)} · n={item.sampleSize}</p></div>)}</div>
    <details className="mt-3 rounded-lg border border-slate-200"><summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-600">Event-by-event and match-phase performance</summary><div className="overflow-x-auto p-3"><table className="w-full min-w-[680px] text-xs"><thead><tr className="border-b text-left text-slate-400"><th className="py-2">Event</th><th>Matches</th><th>W-L</th><th>Win rate</th><th>Mean absolute error</th><th>Residual bias</th><th>Score RMSE</th><th>EPA first → last</th></tr></thead><tbody>{analysis.eventSummaries.map((item)=><tr key={item.event.key} className="border-b border-slate-100"><th className="py-2 text-left font-medium text-slate-700">{item.event.shortName??item.event.name}</th><td>{item.matches}</td><td>{item.wins}–{item.losses}</td><td>{item.winRate===null?"—":`${(item.winRate*100).toFixed(1)}%`}</td><td>{fmt(item.meanAbsoluteError)}</td><td>{item.meanResidual===null?"—":(item.meanResidual>0?"+":"")+fmt(item.meanResidual)}</td><td>{fmt(item.rootMeanSquareError)}</td><td>{fmt(item.epaStart,2)} → {fmt(item.epaEnd,2)}</td></tr>)}</tbody></table><div className="mt-3 flex flex-wrap gap-2">{analysis.phaseSummaries.map((item)=><span key={item.phase} className="rounded bg-slate-50 px-2 py-1 text-[10px] text-slate-600">{item.phase.toUpperCase()}: {item.wins}–{item.losses} · {item.matches} matches</span>)}</div></div></details>
    <p className="mt-3 text-xs text-slate-500">Season match records with Statbotics data: {analysis.collection.statboticsMatches} / {analysis.collection.totalMatches}. Mean score error is calculated from the team's alliance predictions.</p>
  </section>;
}
function SharedMatchEpaComparison({first,second,nameA,nameB}:{first:TeamMatchAnalysis;second:TeamMatchAnalysis;nameA:string;nameB:string}) {
  const byKey=new Map(second.matches.map((m)=>[m.matchKey,m]));
  const shared=first.matches.flatMap((a)=>{const b=byKey.get(a.matchKey);return b&&a.preEPA!==null&&b.preEPA!==null?[{a,b}]:[];});
  if(!shared.length) return <section className="rounded-xl border border-slate-200 p-4"><h3 className="font-semibold text-slate-900">Same-match EPA comparison</h3><p className="mt-1 text-sm text-slate-500">These teams have no common matches with complete pre-match EPA data.</p></section>;
  const values=shared.flatMap(({a,b})=>[a.preEPA as number,b.preEPA as number]);
  const min=Math.min(0,...values),max=Math.max(1,...values),range=Math.max(1,max-min);
  const x=(i:number)=>shared.length<2?450:50+i*800/(shared.length-1);
  const y=(v:number)=>214-(v-min)/range*170;
  const lineA=shared.map(({a},i)=>`${x(i)},${y(a.preEPA as number)}`).join(" ");
  const lineB=shared.map(({b},i)=>`${x(i)},${y(b.preEPA as number)}`).join(" ");
  const mid=Math.floor((shared.length-1)/2);
  return <section className="rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-bold text-slate-900">Same-match EPA comparison</h3><p className="text-xs text-slate-500">Pre-match ratings for both teams in the exact same matches · {shared.length} shared matches</p></div><div className="flex flex-wrap gap-3 text-xs"><span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-blue-600"/>{nameA}</span><span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-teal-600"/>{nameB}</span></div></div>
    <svg viewBox="0 0 900 260" role="img" aria-label={`Pre-match EPA comparison between ${nameA} and ${nameB} across ${shared.length} common matches`} className="mt-3 w-full">
      {[0,1,2,3].map((n)=><g key={n}><line x1="48" x2="858" y1={40+n*56} y2={40+n*56} stroke="#e2e8f0" strokeDasharray="3 4"/><text x="40" y={44+n*56} textAnchor="end" fontSize="10" fill="#64748b">{(max-range*n/3).toFixed(0)}</text></g>)}
      <polyline points={lineA} fill="none" stroke="#2563eb" strokeWidth="2.5" strokeLinejoin="round"/><polyline points={lineB} fill="none" stroke="#0d9488" strokeWidth="2.5" strokeLinejoin="round"/>
      {shared.map(({a,b},i)=><g key={a.matchKey}><circle cx={x(i)} cy={y(a.preEPA as number)} r="4" fill="#2563eb"><title>{a.event.shortName??a.event.name} · {a.matchLabel} · {nameA}: {a.preEPA?.toFixed(2)} EPA</title></circle><circle cx={x(i)} cy={y(b.preEPA as number)} r="4" fill="#0d9488"><title>{b.event.shortName??b.event.name} · {b.matchLabel} · {nameB}: {b.preEPA?.toFixed(2)} EPA</title></circle></g>)}
      <text x="50" y="246" fontSize="10" fill="#64748b">{shared[0].a.matchLabel}</text><text x={x(mid)} y="246" textAnchor="middle" fontSize="10" fill="#64748b">{shared[mid].a.matchLabel}</text><text x="850" y="246" textAnchor="end" fontSize="10" fill="#64748b">{shared[shared.length-1].a.matchLabel}</text>
    </svg>
    <p className="text-[10px] text-slate-500">Comparing ratings at the same point in the season controls for match and event timing. EPA is a model estimate, not a direct measure of robot performance. Hover points for exact values.</p>
  </section>;
}

function TeamMatchEpaLedger({analysis,name,accent}:{analysis:TeamMatchAnalysis;name:string;accent:"blue"|"teal"}) {
  const matches=analysis.matches;
  const color=accent==="blue"?"#2563eb":"#0d9488";
  const epaValues=matches.flatMap((m)=>[m.preEPA,m.postEPA]).filter((v):v is number=>v!==null);
  const epaMin=Math.min(0,...epaValues), epaMax=Math.max(1,...epaValues);
  const epaRange=Math.max(1,epaMax-epaMin);
  const x=(i:number)=>matches.length<2?450:44+i*812/(matches.length-1);
  const y=(v:number)=>214-(v-epaMin)/epaRange*174;
  const pre=matches.flatMap((m,i)=>m.preEPA===null?[]:[`${x(i)},${y(m.preEPA)}`]).join(" ");
  const post=matches.flatMap((m,i)=>m.postEPA===null?[]:[`${x(i)},${y(m.postEPA)}`]).join(" ");
  const residuals=matches.filter((m)=>m.residual!==null);
  const residualMax=Math.max(1,...residuals.map((m)=>Math.abs(m.residual??0)));
  const componentRows=[{key:"auto_epa",actual:"auto",label:"Auto"},{key:"teleop_epa",actual:"teleop",label:"Teleop"},{key:"endgame_epa",actual:"endgame",label:"Endgame"}];
  const componentSeries=componentRows.map((row)=>({ ...row, points:matches.flatMap((m,i)=>{const estimate=m.alliancePreComponents[row.key],actual=m.actualComponents[row.actual];return typeof estimate==="number"&&typeof actual==="number"?[{i,estimate,actual,match:m}]:[];})}));
  return <section className="min-w-0 rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-bold text-slate-900">{name}</h3><p className="text-xs text-slate-500">Season match analysis · {matches.length} matches across {analysis.eventCount} events</p></div><a className="text-xs font-semibold text-blue-700 hover:underline" href={`https://www.thebluealliance.com/team/${analysis.team}/${analysis.year}`} target="_blank" rel="noreferrer">TBA history ↗</a></div>
    <div className="mt-4 rounded-lg border border-slate-100 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-sm font-semibold text-slate-800">EPA progression</h4><p className="text-[11px] text-slate-500">Pre-match and post-match rating at each match</p></div><div className="flex gap-3 text-[11px]"><span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-slate-400"/>Pre</span><span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full" style={{backgroundColor:color}}/>Post</span></div></div>
      <svg viewBox="0 0 900 250" role="img" aria-label={`${name} EPA progression across ${matches.length} matches`} className="mt-2 w-full overflow-visible">
        {[0,1,2,3].map((n)=><g key={n}><line x1="42" x2="862" y1={40+n*58} y2={40+n*58} stroke="#e2e8f0" strokeDasharray="3 4"/><text x="34" y={44+n*58} textAnchor="end" fontSize="10" fill="#64748b">{(epaMax-(epaRange*n/3)).toFixed(0)}</text></g>)}
        {pre&&<polyline points={pre} fill="none" stroke="#94a3b8" strokeWidth="2" strokeDasharray="5 4"/>}
        {post&&<polyline points={post} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round"/>}
        {matches.map((m,i)=><g key={m.matchKey}>{m.preEPA!==null&&<circle cx={x(i)} cy={y(m.preEPA)} r="3" fill="#94a3b8"><title>{m.event.shortName??m.event.name} · {m.matchLabel}: pre-match EPA {m.preEPA.toFixed(2)}</title></circle>}{m.postEPA!==null&&<circle cx={x(i)} cy={y(m.postEPA)} r="3.5" fill={color}><title>{m.event.shortName??m.event.name} · {m.matchLabel}: post-match EPA {m.postEPA.toFixed(2)}{m.sharedAllianceUpdate?" · shared alliance update":""}</title></circle>}</g>)}
        <text x="44" y="238" fontSize="10" fill="#64748b">First match</text><text x="862" y="238" textAnchor="end" fontSize="10" fill="#64748b">Latest match</text>
      </svg>
      <p className="text-[10px] text-slate-500">Each point is a model rating snapshot, not a direct measurement of that match's robot contribution. Hover points for event and match details.</p>
    </div>
    <div className="mt-3 rounded-lg border border-slate-100 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-sm font-semibold text-slate-800">Alliance score prediction residual</h4><p className="text-[11px] text-slate-500">Actual score minus predicted score; positive means the alliance scored above prediction</p></div><span className="text-xs text-slate-500">n={residuals.length}</span></div>
      <svg viewBox="0 0 900 190" role="img" aria-label={`${name} alliance score prediction residuals by match`} className="mt-2 w-full">
        <line x1="42" x2="862" y1="88" y2="88" stroke="#64748b" strokeWidth="1.5"/>
        {residuals.map((m,i)=>{const barW=Math.max(2,Math.min(14,812/residuals.length-2));const bx=48+i*812/Math.max(1,residuals.length);const h=Math.abs(m.residual??0)/residualMax*68;const positive=(m.residual??0)>=0;return <rect key={m.matchKey} x={bx} y={positive?88-h:88} width={barW} height={Math.max(1,h)} rx="1" fill={positive?"#0d9488":"#e11d48"}><title>{m.event.shortName??m.event.name} · {m.matchLabel}: predicted {fmt(m.predicted)}, actual {fmt(m.actual)}, residual {fmt(m.residual)}</title></rect>;})}
        <text x="44" y="177" fontSize="10" fill="#64748b">First match</text><text x="862" y="177" textAnchor="end" fontSize="10" fill="#64748b">Latest match</text>
      </svg>
      <div className="flex gap-4 text-[10px] text-slate-500"><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-teal-600"/>Above prediction</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-rose-600"/>Below prediction</span></div>
    </div>
    <div className="mt-3 rounded-lg border border-slate-100 p-3">
      <h4 className="text-sm font-semibold text-slate-800">Alliance component estimates vs actual</h4><p className="text-[11px] text-slate-500">Pre-match EPA summed across the three alliance teams, compared with TBA's recorded alliance component score</p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">{componentSeries.map((series)=><div key={series.key} className="min-w-0"><div className="flex items-center justify-between"><span className="text-xs font-semibold text-slate-700">{series.label}</span><span className="text-[10px] text-slate-400">n={series.points.length}</span></div><svg viewBox="0 0 280 125" role="img" aria-label={`${series.label} EPA estimate and actual scores`} className="mt-1 w-full"><line x1="20" x2="270" y1="103" y2="103" stroke="#cbd5e1"/>{series.points.map((point,index)=>{const max=Math.max(1,...series.points.flatMap((p)=>[p.estimate,p.actual]));const bw=Math.max(1,Math.min(8,230/Math.max(1,series.points.length*2)));const base=24+index*230/Math.max(1,series.points.length);const h1=point.estimate/max*84,h2=point.actual/max*84;return <g key={point.match.matchKey}><rect x={base} y={103-h1} width={bw} height={h1} fill={color}><title>{point.match.matchLabel}: estimated {point.estimate.toFixed(1)}</title></rect><rect x={base+bw+1} y={103-h2} width={bw} height={h2} fill="#94a3b8"><title>{point.match.matchLabel}: actual {point.actual.toFixed(1)}</title></rect></g>;})}</svg><div className="flex gap-3 text-[10px] text-slate-500"><span><i className="mr-1 inline-block h-2 w-2 rounded-sm" style={{backgroundColor:color}}/>EPA</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-slate-400"/>Actual</span></div></div>)}</div>
      <p className="mt-2 text-[10px] text-slate-500">Hover bars for match values. These are alliance-level estimates and outcomes, not individual robot attribution.</p>
    </div>
    <details className="mt-3 rounded-lg border border-slate-200"><summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-600">Inspect match records ({matches.length})</summary><div className="max-h-96 overflow-auto"><table className="w-full min-w-[760px] text-xs"><thead className="sticky top-0 bg-white text-left text-slate-400"><tr><th className="p-2">Match</th><th>Partners / opponents</th><th>Pre → post EPA</th><th>Predicted / actual</th><th>Residual</th><th>Win chance</th></tr></thead><tbody>{matches.map((m)=><tr key={m.matchKey} className="border-t border-slate-100"><td className="p-2"><a className="font-medium text-blue-700 hover:underline" href={`https://www.thebluealliance.com/match/${m.matchKey}`} target="_blank" rel="noreferrer">{m.matchLabel}</a><span className="block text-[10px] text-slate-400">{m.event.shortName??m.event.name}</span></td><td>{m.partners.join(", ")} / {m.opponents.join(", ")}</td><td className="tabular-nums">{fmt(m.preEPA,2)} → {fmt(m.postEPA,2)}</td><td className="tabular-nums">{fmt(m.predicted)} / {fmt(m.actual)}</td><td className="tabular-nums">{fmt(m.residual)}</td><td className="tabular-nums">{m.teamWinProbability===null?"—":`${(m.teamWinProbability*100).toFixed(0)}%`}</td></tr>)}</tbody></table></div></details>
  </section>;
}
function TeamHistoryComparison({first,second}:{first:TeamSeasonHistory;second:TeamSeasonHistory}) {
  return <div className="mt-4 space-y-5">
    <div className="grid gap-4 xl:grid-cols-2">
      <TeamSeasonProfile history={first} accent="blue" />
      <TeamSeasonProfile history={second} accent="teal" />
    </div>
    <SharedEventComparison first={first} second={second} />
    <details className="rounded-xl border border-slate-200">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-700">Compare detailed EPA component estimates</summary>
      <div className="px-4 pb-4"><p className="mt-1 text-xs text-slate-500">Statbotics modeled contribution estimates. Negative values are below-baseline model estimates, not literal negative points scored. These component estimates describe the model, not independently observed robot scoring.</p><EpaBreakdownComparison first={first} second={second} /></div>
    </details>
  </div>;
}
function SharedEventComparison({first,second}:{first:TeamSeasonHistory;second:TeamSeasonHistory}) {
  const secondByKey=new Map(second.events.map((item)=>[item.event.key,item]));
  const shared=first.events.flatMap((a)=>{
    const b=secondByKey.get(a.event.key);
    const av=a.statbotics?.epa?.total_points, bv=b?.statbotics?.epa?.total_points;
    return b && typeof av==="number" && typeof bv==="number" ? [{a,b,av,bv,gap:av-bv}] : [];
  });
  if(!shared.length) return <section className="rounded-xl border border-slate-200 p-4"><h4 className="font-semibold text-slate-900">Events in common</h4><p className="mt-2 text-sm text-slate-500">No shared events have usable EPA snapshots for both teams.</p></section>;
  const averageGap=shared.reduce((sum,item)=>sum+item.gap,0)/shared.length;
  const winsA=shared.filter((item)=>item.gap>0).length;
  const winsB=shared.filter((item)=>item.gap<0).length;
  const max=Math.max(1,...shared.flatMap((item)=>[item.av,item.bv]));
  const nameA=first.team.nickname || first.team.name || "Team A";
  const nameB=second.team.nickname || second.team.name || "Team B";
  return <section className="rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h4 className="font-semibold text-slate-900">How did they compare at the same events?</h4><p className="mt-1 text-xs text-slate-500">{shared.length} shared events with EPA data. These are event rating snapshots, not head-to-head match results.</p></div>
      <div className="rounded-lg bg-slate-50 px-3 py-2 text-right"><p className="text-[10px] font-semibold uppercase text-slate-500">Average EPA gap</p><p className="text-xl font-black tabular-nums">{averageGap>0?"+":""}{fmt(averageGap)}</p><p className="text-[10px] text-slate-500">{nameA} minus {nameB}</p></div>
    </div>
    <p className="mt-3 text-sm text-slate-700">{averageGap===0?"Their average EPA was equal across these shared events.":averageGap>0?`${nameA} had the higher event EPA at ${winsA} of ${shared.length} shared events; ${nameB} was higher at ${winsB}.`:`${nameB} had the higher event EPA at ${winsB} of ${shared.length} shared events; ${nameA} was higher at ${winsA}.`} This compares the model's estimates, not the teams' direct match outcomes.</p>
    <div className="mt-4 space-y-3">{shared.map(({a,av,bv})=>{
      const label=a.event.short_name ?? a.event.name;
      return <div key={a.event.key} className="grid grid-cols-[minmax(78px,110px)_1fr_1fr] items-center gap-3 text-xs">
        <span className="truncate font-medium text-slate-600" title={label}>{label}</span>
        {[{value:av,color:"bg-blue-600"},{value:bv,color:"bg-teal-600"}].map((item,index)=><div key={index} className="min-w-0"><div className="mb-1 flex justify-between gap-1"><span className="text-[10px] text-slate-400">{index===0?nameA:nameB}</span><strong className="tabular-nums">{fmt(item.value)}</strong></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className={"h-full rounded-full "+item.color} style={{width:`${Math.max(1,item.value/max*100)}%`}} /></div></div>)}
      </div>;
    })}</div>
  </section>;
}
function TeamSeasonProfile({history,accent}:{history:TeamSeasonHistory;accent:"blue"|"teal"}) {
  const events=history.events.filter((item)=>typeof item.statbotics?.epa?.total_points==="number");
  const first=events[0], last=events[events.length-1];
  const firstValue=first?.statbotics?.epa?.total_points ?? null;
  const lastValue=last?.statbotics?.epa?.total_points ?? null;
  const delta=firstValue!==null&&lastValue!==null?lastValue-firstValue:null;
  const record=history.season?.record?.total;
  const qual=history.season?.record?.qual;
  const name=history.team.nickname || history.team.name || "Team";
  const color=accent==="blue"?"bg-blue-600":"bg-teal-600";
  const changeText=delta===null?"Not enough event snapshots":delta===0?"EPA was unchanged across the available event snapshots":`EPA ${delta>0?"increased":"decreased"} by ${fmt(Math.abs(delta))} points from the first to last available event snapshot.`;
  const largest=events.reduce<{label:string;value:number}|null>((best,item)=>{
    const value=item.statbotics?.epa?.total_points;
    return typeof value==="number"&&(!best||value>best.value)?{label:item.event.short_name??item.event.name,value}:best;
  },null);
  const smallest=events.reduce<{label:string;value:number}|null>((best,item)=>{
    const value=item.statbotics?.epa?.total_points;
    return typeof value==="number"&&(!best||value<best.value)?{label:item.event.short_name??item.event.name,value}:best;
  },null);
  return <section className="min-w-0 rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-semibold text-slate-500">Team {history.season?.team ?? history.events[0]?.statbotics?.team ?? ""}</p><h4 className="text-lg font-bold text-slate-950">{name}</h4></div><span className="text-xs font-semibold text-slate-500">{events.length} event snapshots</span></div>
    <div className="mt-4 grid grid-cols-2 gap-2">
      <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Current season EPA</p><p className="mt-1 text-2xl font-black tabular-nums text-slate-950">{fmt(history.season?.epa?.total_points)}</p></div>
      <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Overall record</p><p className="mt-1 text-2xl font-black tabular-nums text-slate-950">{record?`${record.wins??0}-${record.losses??0}-${record.ties??0}`:"—"}</p></div>
    </div>
    <div className="mt-4 rounded-lg border-l-4 border-blue-500 bg-blue-50/60 p-3"><p className="text-sm font-semibold text-slate-900">{changeText}</p><p className="mt-1 text-xs text-slate-600">This is a change in Statbotics' rating estimate, not a direct measurement of robot performance.</p></div>
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between"><h5 className="text-xs font-bold uppercase tracking-wide text-slate-500">Rating progression</h5><span className="text-[11px] text-slate-400">Earlier → later events</span></div>
      <EventEpaBars events={events} color={color} />
    </div>
    <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
      <div className="rounded-lg bg-slate-50 p-3"><p className="text-slate-500">Highest event EPA</p><p className="mt-1 font-bold text-slate-900">{largest?fmt(largest.value):"—"}</p><p className="text-slate-500">{largest?.label??"No data"}</p></div>
      <div className="rounded-lg bg-slate-50 p-3"><p className="text-slate-500">Lowest event EPA</p><p className="mt-1 font-bold text-slate-900">{smallest?fmt(smallest.value):"—"}</p><p className="text-slate-500">{smallest?.label??"No data"}</p></div>
    </div>
    <p className="mt-3 text-xs text-slate-500">{qual?`Qualification record: ${qual.wins??0} wins, ${qual.losses??0} losses · ${fmt(qual.rps_per_match,2)} ranking points per match`:"Qualification record unavailable"}.</p>
    <details className="mt-4 rounded-lg border border-slate-200">
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-700">Detailed event history and EPA components</summary>
      <div className="overflow-x-auto px-3 pb-3"><table className="w-full min-w-[540px] text-xs"><thead><tr className="border-b text-left text-slate-400"><th className="py-2">Event</th><th>EPA</th><th>Change</th><th>Qual W-L</th><th>RP / match</th><th>Rank</th></tr></thead><tbody>{history.events.map((item,index)=>{
        const epa=item.statbotics?.epa?.total_points;
        const previous=index>0?history.events[index-1].statbotics?.epa?.total_points:undefined;
        const change=typeof epa==="number"&&typeof previous==="number"?epa-previous:null;
        const eventQual=item.statbotics?.record?.qual;
        return <tr key={item.event.key} className="border-b border-slate-100"><th className="py-2 text-left font-medium">{item.event.short_name??item.event.name}</th><td className="tabular-nums">{fmt(epa)}</td><td className="tabular-nums">{change===null?"—":(change>0?"+":"")+fmt(change)}</td><td>{eventQual?`${eventQual.wins??0}-${eventQual.losses??0}`:"—"}</td><td>{fmt(eventQual?.rps_per_match,2)}</td><td>{eventQual?.rank!=null?`${eventQual.rank}${eventQual.num_teams?` / ${eventQual.num_teams}`:""}`:"—"}</td></tr>;
      })}</tbody></table>
      {events.length>0&&<div className="mt-3 grid gap-2 sm:grid-cols-2">{events.map((item)=><div key={item.event.key} className="rounded-lg bg-slate-50 p-2"><p className="text-xs font-semibold text-slate-700">{item.event.short_name??item.event.name}</p><div className="mt-1 flex flex-wrap gap-1">{Object.entries(item.statbotics?.epa?.breakdown??{}).filter(([key,value])=>typeof value==="number"&&!/^comp_\d+_epa$/.test(key)).map(([key,value])=><span key={key} className="rounded bg-white px-2 py-1 text-[10px] text-slate-600">{key.replaceAll("_"," ")} <strong>{fmt(value)}</strong></span>)}</div></div>)}</div>}
      </div>
    </details>
  </section>;
}
function HistoryMetric({label,value}:{label:string;value:string}) {
  return <div className="rounded-lg border border-slate-200 bg-white p-2.5"><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 text-lg font-black tabular-nums text-slate-900">{value}</p></div>;
}
function EventEpaBars({events,color}:{events:TeamSeasonHistory["events"];color:string}) {
  const points=events.flatMap((item)=>typeof item.statbotics?.epa?.total_points==="number"?[{label:item.event.short_name ?? item.event.name,value:item.statbotics.epa.total_points}]:[]);
  if(!points.length) return <p className="text-xs text-slate-400">No event EPA snapshots available.</p>;
  const max=Math.max(1,...points.map((point)=>Math.abs(point.value)));
  return <div className="space-y-2">{points.map((point,index)=><div key={index} className="grid grid-cols-[minmax(70px,110px)_1fr_42px] items-center gap-2 text-xs"><span className="truncate text-slate-500" title={point.label}>{point.label}</span><div className="h-3 overflow-hidden rounded-full bg-white"><div className={"h-full rounded-full " + (point.value < 0 ? "bg-rose-500" : color)} style={{width:`${Math.max(2,Math.abs(point.value)/max*100)}%`}} /></div><span className="text-right font-semibold tabular-nums text-slate-700">{fmt(point.value)}</span></div>)}</div>;
}
function EpaBreakdownComparison({first,second}:{first:TeamSeasonHistory;second:TeamSeasonHistory}) {
  const a=first.season?.epa?.breakdown ?? {};
  const b=second.season?.epa?.breakdown ?? {};
  const keys=[...new Set([...Object.keys(a),...Object.keys(b)])].filter((key)=>typeof a[key]==="number"||typeof b[key]==="number").sort();
  if(!keys.length) return <p className="mt-3 text-sm text-slate-500">Component breakdowns are not available for both selected teams.</p>;
  const max=Math.max(1,...keys.flatMap((key)=>[Math.abs(a[key] ?? 0),Math.abs(b[key] ?? 0)]));
  return <div className="mt-3 space-y-3">{keys.map((key)=><div key={key} className="grid grid-cols-[110px_1fr_1fr] items-center gap-3 text-xs">
    <span className="break-words font-medium text-slate-600">{key.replaceAll("_"," ")}</span>
    {[{value:a[key],color:"bg-blue-600"},{value:b[key],color:"bg-teal-600"}].map((item,index)=><div key={index} className="min-w-0"><div className="mb-1 flex justify-between gap-1"><span className="text-[10px] text-slate-400">{index===0?first.team.nickname || first.team.name || "Team A":second.team.nickname || second.team.name || "Team B"}</span><span className="font-semibold tabular-nums">{fmt(item.value)}</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className={"h-full rounded-full "+item.color} style={{width:`${Math.abs(item.value ?? 0)/max*100}%`}} /></div></div>)}
  </div>)}</div>;
}
function Metric({label,value,detail}:{label:string;value:string|number;detail:string}) {
  return <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</p><p className="mt-1 text-2xl font-black tabular-nums text-slate-950">{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>;
}
function Panel({title,description,children}:{title:string;description:string;children:ReactNode}) {
  return <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><h2 className="text-lg font-bold text-slate-900">{title}</h2><p className="mt-1 text-sm text-slate-500">{description}</p><div className="mt-4">{children}</div></section>;
}
function TeamSelect({label,teams,value,onChange}:{label:string;teams:TeamAnalyticsRow[];value:string;onChange:(value:string)=>void}) {
  return <label className="block text-sm font-semibold text-slate-700">{label}<select value={value} onChange={(event)=>onChange(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2"><option value="">Choose a team</option>{teams.map((team)=><option key={team.teamKey} value={team.teamNumber}>{team.teamNumber} · {team.name}</option>)}</select></label>;
}
function TeamCard({team}:{team:TeamAnalyticsRow}) {
  return <div className="rounded-xl bg-slate-50 p-4"><div className="text-xs text-slate-500">Team {team.teamNumber}</div><div className="mt-1 text-xl font-bold text-slate-900">{team.name}</div><div className="mt-3 grid grid-cols-2 gap-3"><div><div className="text-xs text-slate-500">Statbotics EPA</div><div className="text-2xl font-black tabular-nums">{fmt(team.epa)}</div></div><div><div className="text-xs text-slate-500">TBA OPR</div><div className="text-2xl font-black tabular-nums">{fmt(team.opr)}</div></div></div><div className="mt-2 text-xs text-slate-500">{team.matchesSeen} matches represented · EPA event percentile {percentileLabel(team.epaPercentile)}</div></div>;
}
function TeamTable({teams}:{teams:TeamAnalyticsRow[]}) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm"><thead><tr className="border-b text-left text-[11px] uppercase text-slate-400"><th className="py-2">Team</th><th>EPA</th><th>OPR</th><th>DPR</th><th>CCWM</th><th>EPA %ile</th></tr></thead><tbody>{teams.map((team)=><tr key={team.teamKey} className="border-b border-slate-100"><th className="py-2 text-left"><Link className="font-semibold text-slate-800 hover:text-blue-700" href={`/team/${team.teamNumber}`}>{team.teamNumber} · {team.name}</Link></th><td>{fmt(team.epa)}</td><td>{fmt(team.opr)}</td><td>{fmt(team.dpr)}</td><td>{fmt(team.ccwm)}</td><td>{percentileLabel(team.epaPercentile)}</td></tr>)}</tbody></table></div>;
}
function EventOverview({ data }: { data: EventAnalyticsResponse }) {
  const teamByKey = new Map(data.teams.map((team) => [team.teamKey, team]));
  const rankings = data.rankings?.rankings ?? [];
  const completedMatches = data.matches.filter(({ match }) => match.alliances.red.score >= 0 && match.alliances.blue.score >= 0).length;
  const rankedTeams = rankings.map((ranking) => ({ ranking, team: teamByKey.get(ranking.team_key) })).filter((item) => item.team);
  const epaLeaders = [...data.teams].filter((team) => team.epa !== null).sort((a, b) => (b.epa ?? 0) - (a.epa ?? 0)).slice(0, 5);
  const topFinding = data.findings[0];
  const topRanked = rankedTeams[0];
  const secondEpa = epaLeaders[1];
  const leaderGap = epaLeaders[0] && secondEpa ? (epaLeaders[0].epa ?? 0) - (secondEpa.epa ?? 0) : null;
  return <div className="space-y-4">
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <p className="text-xs font-bold uppercase tracking-wide text-blue-700">Event overview</p>
      <h2 className="mt-1 text-lg font-bold text-slate-900">What matters at this event</h2>
      <p className="mt-1 text-sm text-slate-500">A quick read of the competitive picture. Open the supporting views for the underlying standings, ratings, and match evidence.</p>
      <ul className="mt-4 space-y-3">
        <li className="flex gap-3 text-sm leading-6 text-slate-700"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-600"/><span>{topRanked ? <><strong>Current qualification leader:</strong> Team {topRanked.team!.teamNumber} · {topRanked.team!.name} is ranked #{topRanked.ranking.rank}{topRanked.ranking.record ? ` with a ${topRanked.ranking.record.wins}–${topRanked.ranking.record.losses}–${topRanked.ranking.record.ties} record` : ""}.</> : "Official qualification standings are not available yet."}</span></li>
        <li className="flex gap-3 text-sm leading-6 text-slate-700"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-600"/><span>{epaLeaders[0] ? <><strong>Highest current EPA estimate:</strong> Team {epaLeaders[0].teamNumber} · {epaLeaders[0].name} at {fmt(epaLeaders[0].epa)}{leaderGap !== null ? `; ${fmt(leaderGap)} points ahead of the next team` : ""}. This is a model estimate, separate from qualification rank.</> : "Team EPA estimates are not available in the current sample."}</span></li>
        <li className="flex gap-3 text-sm leading-6 text-slate-700"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-600"/><span><strong>Match coverage:</strong> {completedMatches} of {data.matchCount} scheduled matches have scores; {data.loadedMatchCount} have Statbotics records loaded.</span></li>
        <li className="flex gap-3 text-sm leading-6 text-slate-700"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-600"/><span>{topFinding ? <><strong>First match-review signal:</strong> {topFinding.title} — {topFinding.subject}. {topFinding.suggestedAction}</> : "No event-level review signals have crossed the current thresholds in the available sample."}</span></li>
      </ul>
      <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">These are descriptive snapshots, not predictions of final rankings or explanations of team performance. Model coverage may still be incomplete.</p>
    </section>
    <details className="rounded-xl border border-slate-200 bg-white">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-700">Explore standings, team ratings, and prediction diagnostics</summary>
      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Teams competing" value={data.teams.length} detail="Official event roster" />
          <Metric label="Scored matches" value={completedMatches} detail={`${data.matchCount} scheduled matches`} />
          <Metric label="Alliance prediction samples" value={data.predictionStats.allianceCount} detail="Scores with model predictions" />
        </div>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.8fr)]">
          <Panel title="Qualification standings and team strength" description="Official TBA rank alongside Statbotics event EPA. Rank reflects qualification performance and ranking-point rules; EPA estimates team strength.">
            {rankedTeams.length ? <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm"><thead><tr className="border-b text-left text-[11px] uppercase tracking-wide text-slate-400"><th className="py-2 pr-3">Rank</th><th className="py-2 pr-3">Team</th><th className="py-2 pr-3">Record</th><th className="py-2 pr-3">EPA</th><th className="py-2">Event %ile</th></tr></thead><tbody>{rankedTeams.slice(0, 15).map(({ ranking, team }) => <tr key={ranking.team_key} className="border-b border-slate-100"><td className="py-2 pr-3 font-bold tabular-nums">{ranking.rank}</td><th className="py-2 pr-3 text-left font-semibold"><Link className="text-slate-800 hover:text-blue-700" href={`/team/${team!.teamNumber}`}>{team!.teamNumber} · {team!.name}</Link></th><td className="py-2 pr-3 tabular-nums">{ranking.record ? `${ranking.record.wins}-${ranking.record.losses}-${ranking.record.ties}` : "—"}</td><td className="py-2 pr-3 tabular-nums">{fmt(team!.epa)}</td><td className="py-2 tabular-nums">{percentileLabel(team!.epaPercentile)}</td></tr>)}</tbody></table></div> : <p className="text-sm text-slate-500">Official qualification rankings are not available yet. Team strength estimates appear as match data is collected.</p>}
            <p className="mt-3 text-xs text-slate-500">EPA percentiles are relative to the event roster and loaded match sample. They are not season-wide rankings.</p>
          </Panel>
          <Panel title="Highest event EPA" description="The five highest available Statbotics event estimates.">
            {epaLeaders.length ? <ol className="space-y-3">{epaLeaders.map((team, index) => <li key={team.teamKey} className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="text-xs font-bold text-slate-400">#{index + 1}</p><Link href={`/team/${team.teamNumber}`} className="block truncate text-sm font-semibold text-slate-800 hover:text-blue-700">{team.teamNumber} · {team.name}</Link><p className="text-xs text-slate-500">{team.matchesSeen} matches represented</p></div><p className="text-lg font-black tabular-nums text-slate-900">{fmt(team.epa)}</p></li>)}</ol> : <p className="text-sm text-slate-500">EPA leaders will appear as match records become available.</p>}
          </Panel>
        </div>
        <Panel title="Prediction diagnostics" description="How closely Statbotics predictions aligned with recorded alliance scores and match winners in this sample.">
          <div className="grid gap-3 sm:grid-cols-3"><div><p className="text-xs font-bold uppercase tracking-wide text-slate-400">Collection</p><p className="mt-1 text-sm font-semibold capitalize text-slate-800">{data.collection.state}</p><p className="text-xs text-slate-500">{data.collection.processedMatchCount} / {data.collection.totalMatchCount} matches processed</p></div><div><p className="text-xs font-bold uppercase tracking-wide text-slate-400">Average score error</p><p className="mt-1 text-sm font-semibold text-slate-800">{fmt(data.predictionStats.meanAbsoluteError)} points</p><p className="text-xs text-slate-500">Mean absolute alliance-score error</p></div><div><p className="text-xs font-bold uppercase tracking-wide text-slate-400">Winner accuracy</p><p className="mt-1 text-sm font-semibold text-slate-800">{data.predictionStats.winPredictionAccuracy === null ? "—" : `${(data.predictionStats.winPredictionAccuracy * 100).toFixed(1)}%`}</p><p className="text-xs text-slate-500">{data.predictionStats.winPredictionCount} decided matches evaluated</p></div></div>
        </Panel>
      </div>
    </details>
  </div>;
}

function MatchupAnalysis({ data }: { data: EventAnalyticsResponse }) {
  const [matchKey, setMatchKey] = useState(data.matches.find(({ match }) => match.alliances.red.score >= 0 && match.alliances.blue.score >= 0)?.match.key ?? data.matches[0]?.match.key ?? "");
  useEffect(() => {
    setMatchKey(data.matches.find(({ match }) => match.alliances.red.score >= 0 && match.alliances.blue.score >= 0)?.match.key ?? data.matches[0]?.match.key ?? "");
  }, [data.event.key, data.matches]);
  const record = data.matches.find(({ match }) => match.key === matchKey);
  const red = data.allianceResults.find((item) => item.matchKey === matchKey && item.color === "red");
  const blue = data.allianceResults.find((item) => item.matchKey === matchKey && item.color === "blue");
  const teams = new Map(data.teams.map((team) => [team.teamKey, team]));
  const allianceCard = (result: typeof red, label: string) => result ? <div className="rounded-xl border border-slate-200 p-4"><div className="flex items-center justify-between gap-3"><h3 className="font-bold text-slate-900">{label} alliance</h3><span className="text-xs text-slate-500">{result.winner ? "Won" : "Lost"}</span></div><ul className="mt-3 space-y-2">{result.teamKeys.map((key) => { const team = teams.get(key); return <li key={key} className="flex justify-between gap-3 text-sm"><span className="text-slate-700">{team ? `${team.teamNumber} · ${team.name}` : key}</span><span className="tabular-nums text-slate-500">{fmt(team?.epa ?? null)} EPA</span></li>; })}</ul><div className="mt-4 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3"><div><p className="text-[10px] uppercase text-slate-400">Combined pre-match EPA</p><p className="text-lg font-black tabular-nums">{fmt(result.preEpaTotal)}</p></div><div><p className="text-[10px] uppercase text-slate-400">Predicted score</p><p className="text-lg font-black tabular-nums">{fmt(result.predicted)}</p></div><div><p className="text-[10px] uppercase text-slate-400">Actual score</p><p className="text-lg font-black tabular-nums">{fmt(result.actual, 0)}</p></div></div><p className="mt-2 text-xs text-slate-500">Score residual: {result.residual === null ? "—" : `${result.residual > 0 ? "+" : ""}${fmt(result.residual)}`}</p></div> : <div className="rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">Alliance model data is unavailable for this match.</div>;
  return <Panel title="Match analysis" description="Start with the recorded result, then inspect the alliance and model details. This is historical evidence, not a hypothetical matchup prediction.">
    <label className="block max-w-sm text-sm font-semibold text-slate-700">Match<select value={matchKey} onChange={(event) => setMatchKey(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2">{data.matches.map(({ match }) => <option key={match.key} value={match.key}>{matchShortName(match, data.event.playoff_type)} · {match.key}</option>)}</select></label>
    {record ? <>
      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Recorded result</p>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-2"><p className="text-2xl font-black text-slate-900">{fmt(record.match.alliances.red.score,0)} <span className="text-sm font-semibold text-slate-400">Red</span></p><p className="text-2xl font-black text-slate-900">{fmt(record.match.alliances.blue.score,0)} <span className="text-sm font-semibold text-slate-400">Blue</span></p><p className="text-sm font-semibold text-slate-600">{record.match.winning_alliance ? `${record.match.winning_alliance.toUpperCase()} alliance won` : "Winner not recorded"}</p></div>
        <p className="mt-2 text-xs text-slate-500">Model score estimates: red {fmt(red?.predicted ?? null,0)} · blue {fmt(blue?.predicted ?? null,0)}. Residuals: red {red?.residual===null||!red? "—":`${red.residual>0?"+":""}${fmt(red.residual)}`} · blue {blue?.residual===null||!blue? "—":`${blue.residual>0?"+":""}${fmt(blue.residual)}`}.</p>
      </div>
      <details className="mt-3 rounded-lg border border-slate-200"><summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-700">Inspect alliance composition and model estimates</summary><div className="grid gap-3 p-3 md:grid-cols-2">{allianceCard(red, "Red")}{allianceCard(blue, "Blue")}</div></details>
      <a className="mt-3 inline-block text-sm font-semibold text-blue-700 hover:text-blue-900" href={`https://www.thebluealliance.com/match/${record.match.key}`} target="_blank" rel="noreferrer">Open match on The Blue Alliance ↗</a>
    </> : <p className="mt-3 text-sm text-slate-500">No match data is available for this event yet.</p>}
  </Panel>;
}

function ReviewQueue({findings}:{findings:ReviewFinding[]}) {
  const [reviewed,setReviewed] = useState<string[]>([]);
  const [dismissed,setDismissed] = useState<string[]>([]);
  const visible = findings.filter((finding)=>!dismissed.includes(finding.id));
  return <Panel title="Scouting review queue" description="Rule-based signals from the currently loaded match sample. Review state is local to this browser in this prototype.">
    <div className="mb-3 flex flex-wrap gap-3 text-xs text-slate-500"><span>{visible.length} findings</span><span>{reviewed.length} reviewed</span><span>{dismissed.length} dismissed</span></div>
    {!visible.length ? <p className="text-sm text-slate-500">No findings met the current prototype thresholds in this sample.</p> : <div className="space-y-3">{visible.map((finding)=><article key={finding.id} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${finding.severity==="high"?"bg-rose-100 text-rose-700":finding.severity==="medium"?"bg-amber-100 text-amber-800":"bg-slate-100 text-slate-600"}`}>{finding.severity}</span><span className="text-xs text-slate-400">{finding.category === "score-residual" ? "Score surprise" : "Repeated alliance"} · {finding.sampleCoverage} sample coverage · n={finding.sampleSize}</span></div><div className="mt-2 flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-slate-500">{finding.subject}</p>{finding.category === "score-residual" ? <a className="text-xs font-semibold text-blue-700 hover:underline" href={"https://www.thebluealliance.com/match/" + finding.id.split(":")[1]} target="_blank" rel="noreferrer">Open match ↗</a> : null}</div><h3 className="mt-1 font-bold text-slate-900">{finding.title}</h3><p className="mt-1 text-sm text-slate-600">{finding.description}</p><ul className="mt-2 list-disc pl-5 text-xs text-slate-500">{finding.evidence.map((item)=><li key={item}>{item}</li>)}</ul><p className="mt-2 text-xs font-medium text-slate-700">Suggested follow-up: {finding.suggestedAction}</p><div className="mt-3 flex gap-2"><button onClick={()=>setReviewed((current)=>current.includes(finding.id)?current:[...current,finding.id])} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold">{reviewed.includes(finding.id)?"Reviewed":"Mark reviewed"}</button><button onClick={()=>setDismissed((current)=>[...current,finding.id])} className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100">Dismiss</button></div></article>)}</div>}
  </Panel>;
}
function ResidualBars({residuals}:{residuals:{matchKey:string;matchLabel:string;color:string;teamKeys:string[];predicted:number|null;actual:number|null;residual:number|null}[]}) {
  const points=[...residuals].filter((item)=>item.residual!==null&&item.predicted!==null&&item.actual!==null).sort((a,b)=>Math.abs(b.residual??0)-Math.abs(a.residual??0)).slice(0,15);
  if (!points.length) return <p className="text-sm text-slate-500">No completed alliances with both a prediction and an actual score are available in the loaded sample.</p>;
  const maxAbs=Math.max(1,...points.map((item)=>Math.abs(item.residual??0)));
  const positive=points.filter((item)=>(item.residual??0)>0).length;
  const negative=points.filter((item)=>(item.residual??0)<0).length;
  return <div>
    <div className="mb-4 grid grid-cols-3 gap-2">
      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] text-slate-500">Alliances shown</p><p className="text-xl font-bold tabular-nums">{points.length}</p></div>
      <div className="rounded-lg bg-emerald-50 p-3"><p className="text-[11px] text-emerald-700">Above prediction</p><p className="text-xl font-bold tabular-nums text-emerald-800">{positive}</p></div>
      <div className="rounded-lg bg-rose-50 p-3"><p className="text-[11px] text-rose-700">Below prediction</p><p className="text-xl font-bold tabular-nums text-rose-800">{negative}</p></div>
    </div>
    <div className="mb-2 flex flex-wrap justify-between gap-2 text-[11px] text-slate-500"><span>Largest differences first · actual score − predicted score</span><span>Bar length shows size of difference</span></div>
    <div className="space-y-3">
      {points.map((item)=> {
        const value=item.residual??0;
        const width=Math.abs(value)/maxAbs*100;
        return <a key={item.matchKey+item.color} href={`https://www.thebluealliance.com/match/${item.matchKey}`} target="_blank" rel="noreferrer" className="block rounded-lg border border-slate-100 p-3 transition-colors hover:border-blue-200 hover:bg-blue-50/40">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><span className="font-semibold text-slate-900">{item.matchLabel}</span><span className={`ml-2 text-xs font-semibold uppercase ${item.color==="red"?"text-rose-700":"text-blue-700"}`}>{item.color} alliance</span><p className="mt-0.5 text-xs text-slate-500">Teams {item.teamKeys.map((key)=>key.replace(/^frc/i,"")).join(" · ")}</p></div>
            <span className={`text-sm font-bold tabular-nums ${value>=0?"text-emerald-700":"text-rose-700"}`}>{value>0?"+":""}{fmt(value)} pts</span>
          </div>
          <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[11px] text-slate-500"><span className="text-right">Predicted {fmt(item.predicted)}</span><span>→</span><span>Actual {fmt(item.actual)}</span></div>
          <div className="mt-2 flex h-3 items-center rounded-full bg-slate-100">
            <div className="flex h-full w-1/2 justify-end"><div className={`h-full rounded-l-full ${value<0?"bg-rose-500":"bg-transparent"}`} style={{width:value<0?`${width}%`:"0%"}} /></div>
            <div className="h-5 w-px shrink-0 bg-slate-400" />
            <div className="flex h-full w-1/2"><div className={`h-full rounded-r-full ${value>0?"bg-emerald-500":"bg-transparent"}`} style={{width:value>0?`${width}%`:"0%"}} /></div>
          </div>
        </a>;
      })}
    </div>
    <p className="mt-3 text-xs text-slate-500">This ranks alliance-level score differences. It cannot identify which robot caused the difference.</p>
  </div>;
}
function PredictionQuality({stats,residualStats}:{stats:EventAnalyticsResponse["predictionStats"];residualStats:EventAnalyticsResponse["residualStats"]}) {
  const pct = (value:number|null) => value === null ? "—" : (value*100).toFixed(1) + "%";
  const within = stats.allianceCount ? stats.within25Count / stats.allianceCount : null;
  return <div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <QualityMetric label="Mean absolute error" value={fmt(stats.meanAbsoluteError)} unit="pts" detail="Average size of a score prediction miss" />
      <QualityMetric label="Root mean square error" value={fmt(stats.rootMeanSquareError)} unit="pts" detail="Penalizes large misses more heavily" />
      <QualityMetric label="Within ±25 points" value={pct(within)} detail={stats.within25Count + " of " + stats.allianceCount + " alliance scores"} />
      <QualityMetric label="Winner prediction accuracy" value={pct(stats.winPredictionAccuracy)} detail={stats.winPredictionCount + " matches with prediction and result"} />
    </div>
    <div className="mt-5 rounded-lg border border-slate-100 p-4">
      <h3 className="text-sm font-semibold text-slate-900">Prediction bias</h3>
      <p className="mt-1 text-xs text-slate-500">Mean residual = actual score − predicted score. Positive means predictions tended low; negative means predictions tended high.</p>
      <p className={"mt-2 text-2xl font-black tabular-nums " + ((stats.meanResidual ?? 0) >= 0 ? "text-emerald-700" : "text-rose-700")}>{stats.meanResidual === null ? "—" : (stats.meanResidual > 0 ? "+" : "") + fmt(stats.meanResidual) + " pts"}</p>
      <p className="mt-1 text-xs text-slate-500">Residual standard deviation: {fmt(residualStats.standardDeviation)} pts across {residualStats.sampleSize} alliance scores.</p>
    </div>
    <p className="mt-3 text-xs text-slate-500">Score metrics use alliances with both a Statbotics prediction and completed TBA score. Winner accuracy uses matches with a predicted red win probability and recorded winner. This describes this event's sample, not universal model accuracy.</p>
  </div>;
}
function QualityMetric({label,value,unit,detail}:{label:string;value:string;unit?:string;detail:string}) {
  return <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs font-semibold text-slate-500">{label}</p><p className="mt-1 text-2xl font-black tabular-nums text-slate-950">{value}{unit ? <span className="ml-1 text-sm font-semibold text-slate-500">{unit}</span> : null}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>;
}
function AlliancePatterns({findings}:{findings:ReviewFinding[]}) {
  if (!findings.length) return <p className="text-sm text-slate-500">No repeated three-team combinations with a notable average score residual have been identified yet.</p>;
  return <div className="space-y-3">{findings.map((finding)=><article key={finding.id} className="rounded-lg border border-slate-100 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold text-slate-900">{finding.subject}</h3><span className="text-xs text-slate-500">{finding.sampleSize} matches</span></div>
    <p className="mt-1 text-sm text-slate-700">{finding.description}</p>
    <div className="mt-2 flex flex-wrap gap-2">{finding.evidence.map((item)=><span key={item} className="rounded-md bg-slate-50 px-2 py-1 text-xs tabular-nums text-slate-600">{item}</span>)}</div>
    <p className="mt-2 text-xs text-slate-500">{finding.suggestedAction}</p>
  </article>)}</div>;
}
function AllianceTable({records}:{records:EventAnalyticsResponse["matches"]}) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead><tr className="border-b text-left text-[11px] uppercase text-slate-400"><th className="py-2">Match</th><th>Alliance</th><th>Teams</th><th>Pre-match EPA</th><th>Predicted</th><th>Actual</th><th>Residual</th></tr></thead><tbody>{records.flatMap((record)=>(["red","blue"] as const).map((color)=>{const alliance=record.match.alliances[color];const predicted=color==="red"?record.statbotics?.pred?.red_score:record.statbotics?.pred?.blue_score;const values=alliance.team_keys.map((key)=>record.statbotics?.pre_epas?.[key.replace(/^frc/i,"")]?.epa);const epa=values.every((value)=>typeof value==="number")?values.reduce<number>((sum,value)=>sum+(value??0),0):null;const actual=typeof alliance.score==="number"&&alliance.score>=0?alliance.score:null;const residual=actual!==null&&typeof predicted==="number"?actual-predicted:null;return <tr key={record.match.key+color} className="border-b border-slate-100"><th className="py-2 text-left">{matchShortName(record.match, data.event.playoff_type)}</th><td className="capitalize">{color}</td><td>{alliance.team_keys.map((key)=>key.replace(/^frc/i,"")).join(" · ")}</td><td>{fmt(epa)}</td><td>{fmt(predicted)}</td><td>{fmt(actual)}</td><td className={residual!==null&&residual>=0?"text-emerald-700":"text-rose-700"}>{fmt(residual)}</td></tr>}))}</tbody></table></div>;
}