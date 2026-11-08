"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EventAnalyticsResponse, ReviewFinding, TeamAnalyticsRow, TeamInsight } from "@/lib/insights/types";
import { formatTeamNumber, matchCode, matchShortName } from "@/lib/tba/formatters";
import type { StatboticsTeamEvent, StatboticsTeamYear } from "@/lib/statbotics/types";

type TeamSeasonHistory = { team: { nickname?: string | null; name?: string | null }; season: StatboticsTeamYear | null; events: { event: { key: string; name: string; short_name?: string | null; start_date: string; week?: number | null }; statbotics: StatboticsTeamEvent | null; status: "ready" | "unavailable" }[] };
type TeamMatchRow = { matchKey:string; matchLabel:string; compLevel:string; event:{key:string;name:string;shortName?:string|null;startDate:string}; partners:string[]; opponents:string[]; alliance:"red"|"blue"; predicted:number|null; actual:number|null; residual:number|null; opponentPredicted:number|null; opponentActual:number|null; opponentResidual:number|null; alliancePreEPATotal:number|null; alliancePreComponents:Record<string,number>; actualComponents:Record<string,number>; redWinProbability:number|null; teamWinProbability:number|null; rpOutcomes:{key:string;predicted:number|null;achieved:boolean|null}[]; won:boolean|null; preEPA:number|null; postEPA:number|null; deltaEPA:number|null; preComponents:Record<string,number>; postComponents:Record<string,number>; allianceDeltaSpread:number|null; sharedAllianceUpdate:boolean; statboticsAvailable:boolean } ;
type TeamMatchAnalysis = { team:number; year:number; eventCount:number; matchCount:number; anomalySummary:{matchesWithAnomalies:number;matchesEvaluated:number;frequency:number|null;allianceUnderperformance:number;allianceOverperformance:number;opponentAnomalies:number;highConfidenceMisses:number;baseline:string}; anomalies:{matchKey:string;matchLabel:string;event:{key:string;name:string;startDate:string};compLevel:string;partners:string[];opponents:string[];alliance:string;residual:number|null;opponentResidual:number|null;teamWinProbability:number|null;won:boolean|null;kinds:string[];reasons:string[];highConfidenceMiss:boolean}[]; summary:{matches:number;wins:number;losses:number;winRate:number|null;meanResidual:number|null;meanAbsoluteError:number|null;rootMeanSquareError:number|null;meanMatchEPAChange:number|null;epaStart:number|null;epaEnd:number|null;rp:{key:string;sampleSize:number;accuracy:number|null;brier:number|null}[]}; eventSummaries:{event:{key:string;name:string;shortName?:string|null;startDate:string};matches:number;wins:number;losses:number;winRate:number|null;meanResidual:number|null;meanAbsoluteError:number|null;rootMeanSquareError:number|null;meanMatchEPAChange:number|null;epaStart:number|null;epaEnd:number|null}[]; phaseSummaries:{phase:string;matches:number;wins:number;losses:number;winRate:number|null;meanResidual:number|null;meanAbsoluteError:number|null;rootMeanSquareError:number|null;meanMatchEPAChange:number|null;epaStart:number|null;epaEnd:number|null;rp:{key:string;sampleSize:number;accuracy:number|null;brier:number|null}[]}[];eliminationShift:{eliminationMatchCount:number;eligibleEventCount:number;negativeEventCount:number;positiveQualificationEventCount:number;negativeShiftAfterPositiveQualCount:number;meanShift:number|null;medianShift:number|null;signTestPValue:number|null;minimumQualificationMatchesPerEvent:number;minimumEliminationMatchesPerEvent:number;interpretation:"insufficient-history"|"no-elimination-matches"|"single-event-shift"|"recurring-negative-shift"|"no-established-negative-shift";events:{event:{key:string;name:string;shortName?:string|null;startDate:string};qualificationMatches:number;eliminationMatches:number;qualificationMeanResidual:number|null;eliminationMeanResidual:number|null;shift:number;shiftStandardError:number;qualificationMatchKeys:string[];eliminationMatchKeys:string[]}[]};residualPattern:{eligibleEventCount:number;negativeEventCount:number;positiveEventCount:number;meanTeamResidual:number|null;signTestPValue:number|null;positiveSignTestPValue:number|null;interpretation:"insufficient-history"|"single-event-below-baseline"|"single-event-above-baseline"|"recurring-below-baseline"|"recurring-above-baseline"|"no-established-pattern";events:{event:{key:string;name:string;shortName?:string|null;startDate:string};teamMatches:number;baselineAllianceSamples:number;teamMeanResidual:number;baselineMeanResidual:number;baselineStandardDeviation:number;belowOneSigma:number;aboveOneSigma:number;belowBaseline:boolean;matchKeys:string[]}[];diagnostics?:{event:{key:string;name:string;shortName?:string|null;startDate:string};matches:number;scoredMatches:number;teamResidualSamples:number;opponentResidualSamples:number;strengthRatedSamples:number;baselineAllianceSamples:number;eligible:boolean}[]};matches:TeamMatchRow[];collection:{state:string;statboticsMatches:number;totalMatches:number;updatedAt:number}};
type Tab = "overview" | "teams" | "qualification" | "playoffs" | "alliances" | "scouting";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Event Overview" },
  { id: "teams", label: "Team Investigation" },
  { id: "qualification", label: "Qualification Analysis" },
  { id: "playoffs", label: "Playoff Analysis" },
  { id: "alliances", label: "Playoff Alliances" },
  { id: "scouting", label: "Suggested Review" },
];
const fmt = (value: number | null | undefined, digits = 1) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
const percentileLabel = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}th`;

function allianceTeamNumbers(teamNumber: number, otherTeams: string[]): string[] {
  return [...new Set([String(teamNumber), ...otherTeams])];
}

function teamLinkForNumber(teamNumber:number,name:string):ReactNode {
  return <Link href={`/team/${teamNumber}`} className="font-semibold text-slate-800 hover:text-blue-700">{teamNumber} · {name}</Link>;
}

function teamNumberLink(teamNumber:number):ReactNode {
  return <Link href={`/team/${teamNumber}`} className="font-semibold text-slate-800 hover:text-blue-700">{teamNumber}</Link>;
}

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
    <div className="insights-dashboard mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 lg:px-8">
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
            <TeamSnapshot teams={teams} selectedTeam={teamA} onSelect={(value)=>{setTeamA(value);setTeamFocus(value);setTeamB("");}} team={selectedFocus} insight={focusedInsight ?? null} data={data}/>
            {matchAnalysisLoading ? <p className="text-sm text-slate-500">Loading this team's season match history and model records…</p> : null}
            {matchAnalysisError ? <p role="alert" className="text-sm text-rose-700">{matchAnalysisError}</p> : null}
            {matchAnalysisA ? <div className="space-y-4">
              {selectedA && focusedInsight ? <TeamModelDetailPanel team={selectedA} insight={focusedInsight}/> : null}
              <TeamCurrentEventOutlook analysis={matchAnalysisA} records={data.matches} teamNumber={matchAnalysisA.team} eventKey={eventKey} timezone={data.event.timezone ?? null} />
              <TeamRiskPanel analysis={matchAnalysisA} />
              <MatchAnalysisSummary analysis={matchAnalysisA} name={selectedA?.name ?? `Team ${teamA}`} />
              <PhasePerformancePanel analysis={matchAnalysisA} phase="qualification" />
              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <PhasePerformancePanel analysis={matchAnalysisA} phase="elimination" />
                <EliminationShiftPanel analysis={matchAnalysisA} />
              </section>
              <details className="rounded-xl border border-slate-200 bg-white">
                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-700">Season charts and match-by-match evidence</summary>
                <div className="p-4"><TeamMatchEpaLedger analysis={matchAnalysisA} name={selectedA?.name ?? `Team ${teamA}`}/></div>
              </details>
            </div> : !matchAnalysisLoading && !matchAnalysisError && teamA ? <p className="text-sm text-slate-500">No season match analysis is available yet.</p> : null}
          </section>}
          {tab === "qualification" && <QualificationAnalysisPanel data={data} />}
          {tab === "playoffs" && <PlayoffAnalysisPanel data={data} />}
          {tab === "alliances" && <PlayoffAllianceAnalysisPanel data={data} />}
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
  const hasFlags=summary.matchesWithAnomalies>0;
  return <Panel title="Matches worth reviewing" description="These are season-wide investigation leads, not explanations of what caused a result. Open a match to inspect the full alliance context.">
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Matches flagged for review</p>
        <p className="mt-1 text-3xl font-black tabular-nums text-slate-950 dark:text-slate-50">{summary.matchesWithAnomalies}<span className="ml-2 text-sm font-semibold text-slate-500">/ {summary.matchesEvaluated}</span></p>
        <p className="mt-1 text-xs text-slate-500">Matches meeting at least one review rule</p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">High-confidence losses</p>
        <p className="mt-1 text-3xl font-black tabular-nums text-slate-950 dark:text-slate-50">{summary.highConfidenceMisses}</p>
        <p className="mt-1 text-xs text-slate-500">The model gave the alliance at least an 80% chance to win, but it lost</p>
      </div>
    </div>
    <details className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700">
      <summary className="cursor-pointer px-3 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200">How the review flags break down</summary>
      <div className="grid gap-3 border-t border-slate-100 p-3 text-sm dark:border-slate-700 sm:grid-cols-3">
        <div><p className="font-semibold text-slate-900 dark:text-slate-100">{summary.allianceUnderperformance}</p><p className="text-xs text-slate-500">Unusually low alliance scores versus prediction</p></div>
        <div><p className="font-semibold text-slate-900 dark:text-slate-100">{summary.allianceOverperformance}</p><p className="text-xs text-slate-500">Unusually high alliance scores versus prediction</p></div>
        <div><p className="font-semibold text-slate-900 dark:text-slate-100">{summary.opponentAnomalies}</p><p className="text-xs text-slate-500">Unusual results on the opposing alliance</p></div>
      </div>
      <p className="border-t border-slate-100 px-3 py-2 text-xs leading-5 text-slate-500 dark:border-slate-700">{summary.baseline} Flags require at least eight scored observations for the team's season baseline.</p>
    </details>
    {analysis.anomalies.length ? <div className="mt-4 space-y-3">{analysis.anomalies.map((item)=><article key={item.matchKey} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{item.matchLabel} · {item.event.name}</p><p className="text-xs text-slate-500">Our alliance <span className={item.alliance==="red"?"font-semibold text-rose-700":"font-semibold text-blue-700"}>{allianceTeamNumbers(analysis.team,item.partners).join(" · ")}</span> · Opposing alliance <span className={item.alliance==="red"?"font-semibold text-blue-700":"font-semibold text-rose-700"}>{item.opponents.join(" · ")||"—"}</span></p></div><div className="flex flex-wrap gap-1">{item.kinds.map((kind)=><span key={kind} className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-200">{kind.replaceAll("-"," ")}</span>)}</div></div>
      <ul className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300">{item.reasons.map((reason)=><li key={reason}>{reason}</li>)}</ul>
      <a className="mt-2 inline-block text-xs font-semibold text-slate-700 hover:underline dark:text-slate-200" href={`https://www.thebluealliance.com/match/${item.matchKey}`} target="_blank" rel="noreferrer">Inspect match on TBA ↗</a>
    </article>)}</div> : <p className="mt-4 text-sm text-slate-500">{hasFlags?"Flagged matches are not currently available in the loaded sample.":"No matches meet the current review rules."} This does not guarantee every match was routine.</p>}
  </Panel>;
}

function MatchAnalysisSummary({analysis,name}:{analysis:TeamMatchAnalysis;name:string}) {
  const s=analysis.summary;
  const [selectedEvent,setSelectedEvent]=useState(analysis.eventSummaries[0]?.event.key??"");
  const activeEvent=analysis.eventSummaries.find((item)=>item.event.key===selectedEvent)??analysis.eventSummaries[0];
  const rate=(value:number|null)=>value===null?"—":`${(value*100).toFixed(1)}%`;
  return <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-950 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Season results</h3><p className="mt-1 text-xs text-slate-500">{name} · {analysis.matchCount} matches across {analysis.eventCount} official events</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{s.wins} wins · {s.losses} losses</span></div>
    <div className="mt-4 grid gap-3 sm:grid-cols-3">
      <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-900"><p className="text-xs font-semibold text-slate-500">Alliance win rate</p><p className="mt-1 text-2xl font-black tabular-nums text-slate-950 dark:text-slate-50">{rate(s.winRate)}</p><p className="mt-1 text-xs text-slate-500">Across matches involving this team</p></div>
      <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-900"><p className="text-xs font-semibold text-slate-500">Typical score prediction miss</p><p className="mt-1 text-2xl font-black tabular-nums text-slate-950 dark:text-slate-50">{fmt(s.meanAbsoluteError)} <span className="text-sm font-semibold">pts</span></p><p className="mt-1 text-xs text-slate-500">Average absolute difference for the full alliance</p></div>
      <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-900"><p className="text-xs font-semibold text-slate-500">Model strength estimate</p><p className="mt-1 text-2xl font-black tabular-nums text-slate-950 dark:text-slate-50">{fmt(s.epaEnd,1)} <span className="text-sm font-semibold">EPA</span></p><p className="mt-1 text-xs text-slate-500">Latest available estimate in this season's match history</p></div>
    </div>
    <details className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700">
      <summary className="cursor-pointer px-3 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200">Prediction diagnostics and event-by-event results</summary>
      <div className="border-t border-slate-100 p-3 dark:border-slate-700">
        <div className="grid gap-3 sm:grid-cols-3">
          <div><p className="text-xs text-slate-500">Average prediction direction</p><p className="mt-1 font-bold tabular-nums text-slate-900 dark:text-slate-100">{s.meanResidual===null?"—":(s.meanResidual>0?"+":"")+fmt(s.meanResidual)+" pts"}</p><p className="text-xs text-slate-500">Positive = actual alliance score exceeded prediction</p></div>
          <div><p className="text-xs text-slate-500">Large misses weighted more heavily (RMSE)</p><p className="mt-1 font-bold tabular-nums text-slate-900 dark:text-slate-100">{fmt(s.rootMeanSquareError)} pts</p></div>
          <div><p className="text-xs text-slate-500">Matches with model data</p><p className="mt-1 font-bold tabular-nums text-slate-900 dark:text-slate-100">{analysis.collection.statboticsMatches} / {analysis.collection.totalMatches}</p></div>
        </div>
        <div className="mt-4 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Event-by-event results</h4>
          {analysis.eventSummaries.length?<><div role="tablist" aria-label="Season events" className="mt-3 flex flex-wrap gap-2">{analysis.eventSummaries.map((item)=><button key={item.event.key} type="button" role="tab" aria-selected={activeEvent?.event.key===item.event.key} onClick={()=>setSelectedEvent(item.event.key)} className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${activeEvent?.event.key===item.event.key?"border-slate-800 bg-slate-800 text-white dark:border-slate-200 dark:bg-slate-200 dark:text-slate-900":"border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300"}`}>{item.event.name}</button>)}</div>
          {activeEvent?<div role="tabpanel" className="mt-3 grid gap-3 sm:grid-cols-3"><div><p className="text-xs text-slate-500">Alliance record</p><p className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{activeEvent.wins}–{activeEvent.losses}</p></div><div><p className="text-xs text-slate-500">Win rate</p><p className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{rate(activeEvent.winRate)}</p></div><div><p className="text-xs text-slate-500">Typical score miss</p><p className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{fmt(activeEvent.meanAbsoluteError)} pts</p></div></div>:null}</>:<p className="mt-3 text-sm text-slate-500">No event-level match summaries are available.</p>}
        </div>
      </div>
    </details>
    <ResidualPatternPanel analysis={analysis}/>
    <p className="mt-3 text-xs text-slate-500">Score prediction metrics describe the six-team alliance result, not an individual robot's contribution. EPA is a model estimate, not a measured score.</p>
  </section>;
}

function PhasePerformancePanel({analysis,phase}:{analysis:TeamMatchAnalysis;phase:"qualification"|"elimination"}) {
  const isQual=phase==="qualification";
  const phaseData=analysis.phaseSummaries.find((item)=>isQual?/qual|qm|^q$/i.test(item.phase):/elim|playoff|^e$/i.test(item.phase));
  const title=isQual?"Qualification matches":"Elimination matches";
  if(!phaseData) return <section><h3 className="text-base font-bold text-slate-900 dark:text-slate-100">{title}</h3><p className="mt-2 text-sm text-slate-500">No {isQual?"qualification":"elimination"} match sample is available yet.</p></section>;
  return <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-950">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-base font-bold text-slate-900 dark:text-slate-100">{title}</h3><p className="mt-1 text-xs text-slate-500">{phaseData.matches} matches across the official season</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">{phaseData.wins}–{phaseData.losses} alliance record</span></div>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900"><p className="text-xs font-semibold text-slate-500">Alliance win rate</p><p className="mt-1 text-2xl font-black tabular-nums text-slate-950 dark:text-slate-50">{phaseData.winRate===null?"—":`${(phaseData.winRate*100).toFixed(1)}%`}</p><p className="mt-1 text-xs text-slate-500">Results from {isQual?"qualification":"elimination"} matches only</p></div>
      <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900"><p className="text-xs font-semibold text-slate-500">Typical score prediction miss</p><p className="mt-1 text-2xl font-black tabular-nums text-slate-950 dark:text-slate-50">{fmt(phaseData.meanAbsoluteError)} <span className="text-sm font-semibold">pts</span></p><p className="mt-1 text-xs text-slate-500">Average absolute miss for the full alliance</p></div>
    </div>
    <details className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700"><summary className="cursor-pointer px-3 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200">Additional model metrics</summary><div className="grid gap-3 border-t border-slate-100 p-3 dark:border-slate-700 sm:grid-cols-3"><div><p className="text-xs text-slate-500">Prediction direction (actual − predicted)</p><p className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{phaseData.meanResidual===null?"—":(phaseData.meanResidual>0?"+":"")+fmt(phaseData.meanResidual)+" pts"}</p></div><div><p className="text-xs text-slate-500">Large misses weighted more (RMSE)</p><p className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{fmt(phaseData.rootMeanSquareError)} pts</p></div><div><p className="text-xs text-slate-500">Model EPA at first → last match</p><p className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{fmt(phaseData.epaStart,2)} → {fmt(phaseData.epaEnd,2)}</p></div></div></details>
    {isQual&&phaseData.rp.length ? <details className="mt-2 rounded-lg border border-slate-200 dark:border-slate-700"><summary className="cursor-pointer px-3 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200">Ranking-point prediction accuracy</summary><div className="grid grid-cols-3 gap-2 border-t border-slate-100 p-3 dark:border-slate-700">{phaseData.rp.map((item)=><div key={item.key} className="rounded-lg bg-slate-50 p-2 dark:bg-slate-900"><p className="text-[10px] font-semibold uppercase text-slate-500">{item.key} RP</p><p className="text-sm font-bold text-slate-900 dark:text-slate-100">{item.accuracy===null?"—":`${(item.accuracy*100).toFixed(1)}%`}</p><p className="text-[10px] text-slate-500">{item.sampleSize} matches · Brier {fmt(item.brier,3)}</p></div>)}</div></details>:null}
    <p className="mt-3 text-xs text-slate-500">{isQual?"Alliance residuals include partners and opponents; they cannot isolate this team's contribution.":"Elimination samples are usually smaller; treat these results as descriptive, not definitive."}</p>
  </section>;
}

function QualificationAnalysisPanel({data}:{data:EventAnalyticsResponse}) {
  const matches=data.matches.filter(({match})=>match.comp_level==="qm").sort((a,b)=>a.match.match_number-b.match.match_number);
  return <Panel title="Qualification match analysis" description="All qualification matches are listed here, not only matches that triggered a review flag.">
    <MatchAnalysisTable data={data} records={matches} playoff={false}/>
    <p className="mt-3 text-xs text-slate-500">High-Confidence Miss and Anomalous Score are independent findings. Both alliances remain visible for context, including matches with no finding.</p>
  </Panel>;
}

function MatchAnalysisTable({data,records,playoff}:{data:EventAnalyticsResponse;records:EventAnalyticsResponse["matches"];playoff:boolean}) {
  const teams=new Map(data.teams.map((team)=>[team.teamKey,team]));
  const threshold=data.residualStats.standardDeviation===null?null:2*data.residualStats.standardDeviation;
  const category=(matchKey:string,color:"red"|"blue",played:boolean)=>{
    const result=data.allianceResults.find((item)=>item.matchKey===matchKey&&item.color===color);
    if(!played)return {label:"Not played",tone:"bg-slate-50 text-slate-400",result};
    if(!result||result.actual===null||result.predicted===null||result.residual===null)return {label:"Statbotics unavailable",tone:"bg-slate-100 text-slate-600",result};
    const prediction=data.matches.find((item)=>item.match.key===matchKey)?.statbotics?.pred?.red_win_prob;
    const winProbability=typeof prediction==="number"?(color==="red"?prediction:1-prediction):null;
    const predictedOutcome=winProbability===null?"Win prediction unavailable":winProbability>=0.5?"Pred. Win":"Pred. Loss";
    const outcomeTone=winProbability===null?"bg-slate-100 text-slate-600":"bg-slate-100 text-slate-700";
    if(playoff)return threshold!==null&&Math.abs(result.residual)>threshold?{label:"Anomalous Score",tone:"bg-amber-100 text-amber-800",result}:{label:predictedOutcome,tone:outcomeTone,result};
    const anomaly=data.qualificationAnomalies?.find((item)=>item.matchKey===matchKey&&item.alliance===color);
    const labels=[...(anomaly?.highConfidenceMiss?["High-Confidence Miss"]:[]),...(anomaly?.outsideExpectedRange?["Anomalous Score"]:[])];
    return labels.length?{label:labels.join(" · "),tone:"bg-amber-100 text-amber-800",result}:{label:predictedOutcome,tone:outcomeTone,result};
  };
  if(!records.length)return <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">{playoff?"No playoff matches are available yet.":"No qualification matches are available yet."}</p>;
  return <div className="overflow-x-auto"><table className="w-full min-w-[760px] table-fixed text-xs"><colgroup><col className="w-[13%]"/><col className="w-[43.5%]"/><col className="w-[43.5%]"/></colgroup><thead><tr className="border-b text-left text-[10px] uppercase tracking-wide text-slate-400"><th className="py-2 pr-2">Match</th><th className="py-2 pr-2 text-rose-800">Red alliance</th><th className="py-2 text-blue-800">Blue alliance</th></tr></thead><tbody>{records.map(({match,statbotics})=>{
    const played=match.alliances.red.score>=0&&match.alliances.blue.score>=0;
    const allianceCell=(color:"red"|"blue")=>{
      const alliance=match.alliances[color],status=category(match.key,color,played),result=status.result,actual=alliance.score>=0?alliance.score:null,residual=result?.residual;
      const redWinProbability=statbotics?.pred?.red_win_prob;
      const winProbability=typeof redWinProbability==="number"?(color==="red"?redWinProbability:1-redWinProbability):null;
      const scoreWinner=played&&match.alliances.red.score!==match.alliances.blue.score?(match.alliances.red.score>match.alliances.blue.score?"red":"blue"):null;
      const isWinner=match.winning_alliance===color||(!match.winning_alliance&&scoreWinner===color);
      return <td key={color} className="py-1.5 pr-2 align-middle"><div className={"grid min-w-0 grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)] items-center gap-2 rounded-md border px-2 py-1.5 "+(color==="red"?(isWinner?"border-rose-500 bg-rose-100 ring-1 ring-rose-300":"border-rose-100 bg-rose-50/40"):(isWinner?"border-blue-500 bg-blue-100 ring-1 ring-blue-300":"border-blue-100 bg-blue-50/40"))}>
        <div className="min-w-0">
          <div className={"flex min-w-0 flex-wrap gap-x-1.5 text-sm font-bold tabular-nums "+(color==="red"?"text-rose-950":"text-blue-950")}>{alliance.team_keys.map((key)=><span key={key}>{teams.has(key)?String(teams.get(key)!.teamNumber):formatTeamNumber(key)}</span>)}</div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
            {isWinner?<span className={"shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-black uppercase leading-3 "+(color==="red"?"bg-rose-700 text-white":"bg-blue-700 text-white")}>Win</span>:null}
            <span title={status.label} aria-label={`${color} alliance: ${status.label}`} className={"inline-flex max-w-full whitespace-normal rounded-full px-1.5 py-0.5 text-[9px] font-bold leading-3 "+status.tone}>{status.label}</span>
          </div>
        </div>
        <div className="grid min-w-0 grid-cols-4 gap-1 border-l border-slate-200/70 pl-2 text-center">
          <div className="min-w-0"><p className="truncate text-[8px] uppercase tracking-tight text-slate-500">Win Chance</p><strong className="block truncate text-sm font-semibold leading-5 tabular-nums text-slate-700">{winProbability===null?"—":`${Math.round(winProbability*100)}%`}</strong></div>
          <div className="min-w-0"><p className="truncate text-[8px] uppercase tracking-tight text-slate-500">Pred. Score</p><strong className="block truncate text-sm font-semibold leading-5 tabular-nums text-slate-800">{result?.predicted===null||result?.predicted===undefined?"—":fmt(result.predicted,0)}</strong></div>
          <div className="min-w-0"><p className="truncate text-[8px] uppercase tracking-tight text-slate-500">Actual Score</p><strong className={"block truncate text-sm font-bold leading-5 tabular-nums "+(color==="red"?"text-red-600":"text-blue-600")}>{actual===null?"—":fmt(actual,0)}</strong></div>
          <div className="min-w-0"><p className="truncate text-[8px] uppercase tracking-tight text-slate-500">Score Delta</p><strong className={"block truncate text-sm font-semibold leading-5 tabular-nums "+(residual===null||residual===undefined?"text-slate-400":residual>0?"text-emerald-600":residual<0?"text-rose-600":"text-slate-500")}>{residual===null||residual===undefined?"—":(residual>0?"+":"")+fmt(residual,0)}</strong></div>
        </div>
      </div></td>;
    };
    return <tr key={match.key} className="border-b border-slate-100"><th className="py-1.5 pr-2 text-left whitespace-nowrap"><a href={"https://www.thebluealliance.com/match/"+match.key} target="_blank" rel="noreferrer" className="text-[11px] font-semibold text-slate-900 hover:text-slate-600 hover:underline">{matchShortName(match,data.event.playoff_type)}</a></th>{allianceCell("red")}{allianceCell("blue")}</tr>;
  })}</tbody></table></div>;
}

function PlayoffAnalysisPanel({data}:{data:EventAnalyticsResponse}) {
  const matches=data.matches.filter(({match})=>match.comp_level!=="qm").sort((a,b)=>{const order=["ef","qf","sf","f"];return order.indexOf(a.match.comp_level)-order.indexOf(b.match.comp_level)||a.match.set_number-b.match.set_number||a.match.match_number-b.match.match_number;});
  return <Panel title="Playoff match analysis" description="Every elimination match is listed, with alliance-level score comparisons and anomalous-score findings."><MatchAnalysisTable data={data} records={matches} playoff/><p className="mt-3 text-xs text-slate-500">Anomalous Score marks alliance residuals more than two event standard deviations from zero. Match-level outcomes describe the alliance, not an individual robot.</p></Panel>;
}

function PlayoffAllianceAnalysisPanel({data}:{data:EventAnalyticsResponse}) {
  const playoff=data.playoffAnalysis;
  const teamsByKey=new Map(data.teams.map((team)=>[team.teamKey,team]));
  if(!playoff||!playoff.alliances.length)return <Panel title="Playoff alliance investigation" description="Compare official playoff alliances across their elimination performance."><p className="text-sm text-slate-500">Playoff alliance data will appear when TBA publishes the alliance selections and completed match results.</p></Panel>;
  const status=(alliance:typeof playoff.alliances[number])=>{
    if(alliance.scoredMatchCount<2||alliance.meanResidual===null||alliance.residualStandardDeviation===null)return {label:"Insufficient sample",tone:"bg-slate-100 text-slate-600"};
    const margin=1.96*alliance.residualStandardDeviation/Math.sqrt(alliance.scoredMatchCount);
    if(alliance.meanResidual>margin)return {label:"Above prediction",tone:"bg-emerald-100 text-emerald-800"};
    if(alliance.meanResidual< -margin)return {label:"Below prediction",tone:"bg-rose-100 text-rose-800"};
    return {label:"Within expected range",tone:"bg-slate-100 text-slate-700"};
  };
  return <Panel title="Playoff alliance performance" description="Alliance-level results across elimination matches. Residuals compare actual alliance scores with Statbotics predictions; they do not isolate individual team or robot contribution.">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><QualityMetric label="Alliances" value={String(playoff.alliances.length)} detail="Official playoff alliances"/><QualityMetric label="Elimination matches" value={String(playoff.matchCount)} detail="Matches represented in the analysis"/><QualityMetric label="Alliances above prediction" value={String(playoff.alliances.filter((a)=>status(a).label==="Above prediction").length)} detail="Mean residual clears uncertainty margin"/><QualityMetric label="Alliances below prediction" value={String(playoff.alliances.filter((a)=>status(a).label==="Below prediction").length)} detail="Mean residual clears uncertainty margin"/></div>
    <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200"><table className="w-full min-w-[850px] text-sm"><thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-3">Alliance</th><th className="px-3 py-3">Teams</th><th className="px-3 py-3">Record</th><th className="px-3 py-3">Mean residual</th><th className="px-3 py-3">Residual SD</th><th className="px-3 py-3">Matches</th><th className="px-3 py-3">Assessment</th></tr></thead><tbody>{playoff.alliances.map((alliance,index)=>{const result=status(alliance);return <tr key={alliance.name??alliance.teamKeys.join("|")+index} className="border-t border-slate-100 align-middle"><th className="px-3 py-3 text-left font-semibold text-slate-900">{alliance.name??`Alliance ${index+1}`}</th><td className="px-3 py-3"><div className="flex flex-wrap gap-x-2 gap-y-1">{alliance.teamKeys.map((key)=><span key={key} className="whitespace-nowrap">{teamsByKey.has(key)?teamLinkForNumber(teamsByKey.get(key)!.teamNumber,teamsByKey.get(key)!.name):formatTeamNumber(key)}</span>)}</div></td><td className="px-3 py-3 tabular-nums">{alliance.wins}–{alliance.losses}–{alliance.ties}</td><td className={"px-3 py-3 font-semibold tabular-nums "+(alliance.meanResidual===null?"text-slate-400":alliance.meanResidual>0?"text-emerald-700":alliance.meanResidual<0?"text-rose-700":"text-slate-700")}>{alliance.meanResidual===null?"—":(alliance.meanResidual>0?"+":"")+fmt(alliance.meanResidual)+" pts"}</td><td className="px-3 py-3 tabular-nums">{fmt(alliance.residualStandardDeviation)} pts</td><td className="px-3 py-3 tabular-nums">{alliance.scoredMatchCount}</td><td className="px-3 py-3"><span className={"inline-flex rounded-full px-2 py-1 text-[10px] font-bold "+result.tone}>{result.label}</span></td></tr>;})}</tbody></table></div>
    <p className="mt-3 text-xs leading-5 text-slate-500">Assessment uses the alliance mean residual and an approximate 95% confidence margin (1.96 × sample standard deviation / √n), requiring at least two scored matches. Small samples are explicitly marked insufficient. Official alliance names are used when supplied by TBA; otherwise a neutral alliance number is shown.</p>
  </Panel>;
}


function TeamCurrentEventOutlook({analysis,records,teamNumber,eventKey,timezone}:{analysis:TeamMatchAnalysis;records:EventAnalyticsResponse["matches"];teamNumber:number;eventKey:string;timezone:string|null}) {
  const currentMatches=analysis.matches.filter((match)=>match.event.key===eventKey);
  const ordered=[...currentMatches].sort((a,b)=>a.matchKey.localeCompare(b.matchKey,undefined,{numeric:true}));
  const scored=ordered.filter((match)=>match.actual!==null&&match.opponentActual!==null);
  const completed=scored.filter((match)=>match.won!==null);
  const wins=completed.filter((match)=>match.won===true).sort((a,b)=>((b.actual??0)-(b.opponentActual??0))-((a.actual??0)-(a.opponentActual??0)));
  const biggestWin=wins[0]??null;
  const upsetLoss=completed.filter((match)=>match.won===false&&match.teamWinProbability!==null&&match.teamWinProbability>=0.65).sort((a,b)=>(b.teamWinProbability??0)-(a.teamWinProbability??0))[0]??null;
  const unexpectedWin=completed.filter((match)=>match.won===true&&match.teamWinProbability!==null&&match.teamWinProbability<=0.35).sort((a,b)=>(a.teamWinProbability??1)-(b.teamWinProbability??1))[0]??null;
  let streakCount=0;
  let streakResult:boolean|null=null;
  for (const match of [...completed].reverse()) {
    if (match.won===null) break;
    if (streakResult===null) streakResult=match.won;
    if (match.won!==streakResult) break;
    streakCount++;
  }
  const streakLabel=streakResult===null||streakCount===0?"No active streak":`${streakCount} ${streakResult?"win":"loss"}${streakCount===1?"":"s"}`;
  const upcoming=records.flatMap((record)=>{
    const match=record.match;
    if(match.event_key!==eventKey)return [];
    const red=match.alliances.red.team_keys.map((key)=>key.replace(/^frc/i,""));
    const blue=match.alliances.blue.team_keys.map((key)=>key.replace(/^frc/i,""));
    const alliance=red.includes(String(teamNumber))?"red":blue.includes(String(teamNumber))?"blue":null;
    if(!alliance || match.alliances.red.score>=0 || match.alliances.blue.score>=0) return [];
    const stat=record.statbotics as unknown as {predicted_time?:number|null;pred?:{red_score?:number|null;blue_score?:number|null;red_win_prob?:number|null}|null}|null;
    if(!stat?.pred) return [];
    const probability=stat.pred.red_win_prob;
    const teamWinProbability=typeof probability==="number"?(alliance==="red"?probability:1-probability):null;
    return [{key:match.key,label:matchShortName(match),alliance,redTeams:red,blueTeams:blue,redScore:stat.pred.red_score??null,blueScore:stat.pred.blue_score??null,teamWinProbability,time:stat.predicted_time??match.time??null}];
  }).sort((a,b)=>(a.time??Number.MAX_SAFE_INTEGER)-(b.time??Number.MAX_SAFE_INTEGER));
  const formatEventTime=(timestamp:number|null)=>{
    if(timestamp===null||!timezone)return "Time unavailable";
    return new Intl.DateTimeFormat("en-US",{timeZone:timezone,weekday:"short",hour:"numeric",minute:"2-digit"}).format(new Date(timestamp*1000));
  };
  const past=[...completed].reverse().slice(0,8);
  const estimatedShare=(match:TeamMatchRow)=>{
    if(match.preEPA===null||match.alliancePreEPATotal===null||match.alliancePreEPATotal<=0||match.preEPA<0||match.preEPA>match.alliancePreEPATotal)return null;
    return match.preEPA/match.alliancePreEPATotal*100;
  };
  const teamAllianceClass=(alliance:"red"|"blue")=>alliance==="red"?"text-rose-700":"text-blue-700";
  const opponentAllianceClass=(alliance:"red"|"blue")=>alliance==="red"?"text-blue-700":"text-rose-700";
  const standout=(match:TeamMatchRow,label:string,tone:"win"|"loss"|"surprise",description:string)=>{
    const margin=(match.actual??0)-(match.opponentActual??0);
    const toneClass=tone==="win"?"border-emerald-200 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/30":tone==="loss"?"border-rose-200 bg-rose-50/70 dark:border-rose-900 dark:bg-rose-950/30":"border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/30";
    const allianceLabel=match.alliance==="red"?"Red alliance":"Blue alliance";
    return <article key={match.matchKey} className={`rounded-lg border p-3 ${toneClass}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[10px] font-black uppercase tracking-wide">{label}</span><a className="text-xs font-semibold text-slate-600 hover:underline" href={`https://www.thebluealliance.com/match/${match.matchKey}`} target="_blank" rel="noreferrer">{match.matchLabel} ↗</a></div>
      <p className="mt-2 text-xs font-semibold text-slate-500">{allianceLabel} · {allianceTeamNumbers(teamNumber,match.partners).length} robots</p>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm"><p className={`font-bold ${teamAllianceClass(match.alliance)}`}>{allianceTeamNumbers(teamNumber,match.partners).join(" · ")}</p><p className={`mt-0.5 text-xs font-semibold ${opponentAllianceClass(match.alliance)}`}>vs {match.opponents.join(" · ")||"opponents"}</p></div>
        <p className="shrink-0 text-xl font-black tabular-nums"><span className={teamAllianceClass(match.alliance)}>{fmt(match.actual,0)}</span><span className="px-1 text-slate-400">–</span><span className={opponentAllianceClass(match.alliance)}>{fmt(match.opponentActual,0)}</span></p>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-600 dark:text-slate-300">{description} <span className="font-semibold">Pre-match win probability: {match.teamWinProbability===null?"unavailable":(match.teamWinProbability*100).toFixed(0)+"%"}.</span></p>
      <p className={`mt-1 text-xs font-bold tabular-nums ${margin>0?"text-emerald-700":margin<0?"text-rose-700":"text-slate-500"}`}>{margin>0?"+":""}{fmt(margin,0)} alliance points</p>
    </article>;
  };
  const highlights=[
    biggestWin?standout(biggestWin,"Biggest win","win",`Won by ${fmt((biggestWin.actual??0)-(biggestWin.opponentActual??0),0)} points.`):null,
    upsetLoss?standout(upsetLoss,"Unexpected loss","loss",`The model favored this alliance despite the loss.`):unexpectedWin?standout(unexpectedWin,"Unexpected win","surprise",`The model expected this alliance to lose, but it won.`):null,
    upsetLoss&&unexpectedWin?standout(unexpectedWin,"Unexpected win","surprise","The model expected this alliance to lose, but it won."):null,
  ].filter((item):item is NonNullable<typeof item>=>item!==null);
  return <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-base font-bold text-slate-900">Current event match outlook</h3><p className="mt-1 text-xs text-slate-500">How the team has performed at this event, which results stand out, and what its remaining matchups look like.</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">{streakResult===null?"No current streak":`${streakCount}-match ${streakResult?"win":"loss"} streak`}</span></div>
    <div className="mt-3 grid gap-2 sm:grid-cols-3">
      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] font-semibold text-slate-500">Event record</p><p className="mt-1 text-xl font-black tabular-nums text-slate-900">{completed.filter((match)=>match.won).length}–{completed.filter((match)=>match.won===false).length}–{scored.length-wins.length-completed.filter((match)=>match.won===false).length}</p><p className="text-[11px] text-slate-500">{scored.length} scored matches</p></div>
      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] font-semibold text-slate-500">Recent form</p><p className="mt-1 text-xl font-black tabular-nums text-slate-900">{streakLabel}</p><p className="text-[11px] text-slate-500">Current consecutive result streak</p></div>
      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] font-semibold text-slate-500">Remaining schedule</p><p className="mt-1 text-xl font-black tabular-nums text-slate-900">{upcoming.length}</p><p className="text-[11px] text-slate-500">Upcoming matches with model predictions</p></div>
    </div>
    <div className="mt-4 border-t border-slate-100 pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold text-slate-800">Standout matches at this event</h4><p className="text-xs text-slate-500">Largest win and strongest prediction upsets in this event's completed matches</p></div>
      {highlights.length?<div className="mt-3 grid gap-3 lg:grid-cols-2">{highlights}</div>:<p className="mt-2 text-sm text-slate-500">No completed match with a standout margin or strong prediction upset is available at this event yet.</p>}
    </div>
    <div className="mt-4 grid gap-4 xl:grid-cols-2">
      <div className="min-w-0"><h4 className="text-sm font-semibold text-slate-800">Recent matches</h4>
        {past.length?<div className="mt-2 overflow-x-auto"><table className="w-full min-w-[510px] text-xs"><thead className="text-left text-[10px] uppercase tracking-wide text-slate-400"><tr><th className="py-2">Match</th><th>Alliance teams</th><th>Alliance score<br/>predicted → actual</th><th>Auto</th><th>Teleop</th><th>Endgame</th><th>EPA share*</th></tr></thead><tbody>{past.map((match)=><tr key={match.matchKey} className="border-t border-slate-100"><th className="py-2 text-left"><a className="font-semibold text-slate-800 hover:underline" href={`https://www.thebluealliance.com/match/${match.matchKey}`} target="_blank" rel="noreferrer">{match.matchLabel}</a><span className={`block text-[10px] font-semibold ${match.alliance==="red"?"text-rose-700":"text-blue-700"}`}>{match.alliance==="red"?"Red":"Blue"} alliance · {match.won===null?"—":match.won?"Win":"Loss"}</span></th><td><div className="min-w-[105px] space-y-1"><p className={`font-semibold ${teamAllianceClass(match.alliance)}`}>{allianceTeamNumbers(teamNumber,match.partners).join(" · ")}</p><p className={`font-semibold ${opponentAllianceClass(match.alliance)}`}>{match.opponents.join(" · ")}</p></div></td><td className="whitespace-nowrap tabular-nums"><span className={teamAllianceClass(match.alliance)}>{fmt(match.predicted)}</span><span className="px-1 text-slate-400">→</span><span className={teamAllianceClass(match.alliance)}>{fmt(match.actual)}</span></td>{(["auto","teleop","endgame"] as const).map((component)=>{const estimate=match.alliancePreComponents[`${component}_epa`];const actual=match.actualComponents[component];return <td key={component} className={`whitespace-nowrap tabular-nums ${teamAllianceClass(match.alliance)}`}>{fmt(estimate)} → {fmt(actual)}</td>;})}<td className="tabular-nums">{estimatedShare(match)===null?"—":fmt(estimatedShare(match))+"%"}</td></tr>)}</tbody></table></div>:<p className="mt-2 text-sm text-slate-500">No completed matches for this team are available at this event yet.</p>}
        <p className="mt-2 text-[10px] leading-5 text-slate-500">Predicted and actual scores are alliance totals. Auto, teleop, and endgame show estimated alliance contribution versus recorded points. EPA share is the team's pre-match EPA divided by its alliance's combined pre-match EPA; it is a model-based estimate, not observed scoring attribution.</p>
      </div>
      <div className="min-w-0"><h4 className="text-sm font-semibold text-slate-800">Upcoming matches</h4>
        {upcoming.length?<div className="mt-2 space-y-2">{upcoming.map((match)=>{
          const close=match.teamWinProbability!==null&&Math.abs(match.teamWinProbability-0.5)<=0.15;
          const opposing=match.alliance==="red"?"blue":"red";
          return <a key={match.key} href={`https://www.thebluealliance.com/match/${match.key}`} target="_blank" rel="noreferrer" className="block rounded-lg border border-slate-200 p-3 hover:border-slate-400">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold text-slate-900">{match.label}</span><span className="text-[10px] text-slate-500">{formatEventTime(match.time)} · event time</span></div>
            <div className="mt-2 space-y-1 text-xs"><p className="font-semibold text-rose-700">{match.redTeams.join(" · ")}</p><p className="font-semibold text-blue-700">{match.blueTeams.join(" · ")}</p></div><div className="mt-2 flex items-center justify-between gap-3 text-sm"><span className={`font-bold tabular-nums ${teamAllianceClass(match.alliance)}`}>{match.alliance==="red"?"RED":"BLUE"} · {match.alliance==="red"?fmt(match.redScore):fmt(match.blueScore)}</span><span className="text-slate-400">vs</span><span className={`font-bold tabular-nums ${teamAllianceClass(opposing)}`}>{opposing.toUpperCase()} · {match.alliance==="red"?fmt(match.blueScore):fmt(match.redScore)}</span></div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500"><span>Team alliance win probability: {match.teamWinProbability===null?"—":(match.teamWinProbability*100).toFixed(0)+"%"}</span><span className={close?"font-semibold text-amber-700":"text-slate-500"}>{close?"Closest projected matchup":"Model projection"}</span></div>
          </a>;
        })}</div>:<p className="mt-2 text-sm text-slate-500">No upcoming match with a published Statbotics prediction is available at this event.</p>}
        <p className="mt-2 text-[10px] leading-5 text-slate-500">Projected scores and win probability are alliance-level Statbotics predictions. A close matchup means the model sees a relatively even contest; it does not establish tournament or ranking-point importance.</p>
      </div>
    </div>

  </section>;
}

function TeamPerformanceHeadline({data,team,insight}:{data:EventAnalyticsResponse;team:TeamAnalyticsRow;insight:TeamInsight}) {
  type Change = {key:string;label:string;delta:number;rank:number;fieldSize:number};
  const records=data.seasonCohort?.records??[];
  const currentEventKey=data.event.key;
  const priorFor=(teamNumber:number)=>records.filter((record)=>record.teamNumber===teamNumber&&record.status==="ready"&&record.event.startDate<data.event.start_date).sort((a,b)=>b.event.startDate.localeCompare(a.event.startDate))[0];
  const currentFor=(teamNumber:number)=>records.find((record)=>record.teamNumber===teamNumber&&record.event.key===currentEventKey&&record.status==="ready");
  const read=(record:{breakdown:Record<string,number>;epaTotal:number|null}|undefined,keys:string[]):number|null=>{
    for(const key of keys){const value=record?.breakdown?.[key];if(typeof value==="number"&&Number.isFinite(value))return value;}
    return null;
  };
  const definitions=[
    {key:"total",label:"Overall EPA",keys:[] as string[]},
    {key:"auto",label:"Autonomous EPA",keys:["auto_epa","auto","auto_points"]},
    {key:"teleop",label:"Teleop EPA",keys:["teleop_epa","teleop","teleop_points"]},
    {key:"endgame",label:"Endgame EPA",keys:["endgame_epa","endgame","endgame_points"]},
  ];
  const teamChanges=definitions.flatMap((definition)=>{
    const current=currentFor(team.teamNumber),prior=priorFor(team.teamNumber);
    const currentValue=definition.key==="total"?(current?.epaTotal??team.epa):read(current,definition.keys);
    const priorValue=definition.key==="total"?(prior?.epaTotal??null):read(prior,definition.keys);
    const fallbackTotal=definition.key==="total"?(insight.seasonComparison?.change??null):null;
    const delta:number|null=currentValue!=null&&priorValue!=null?currentValue-priorValue:fallbackTotal;
    if(delta===null||!Number.isFinite(delta))return [];
    const peerDeltas=data.teams.flatMap((peer)=>{
      const peerCurrent=currentFor(peer.teamNumber),peerPrior=priorFor(peer.teamNumber);
      const now=definition.key==="total"?(peerCurrent?.epaTotal??peer.epa):read(peerCurrent,definition.keys);
      const before=definition.key==="total"?(peerPrior?.epaTotal??null):read(peerPrior,definition.keys);
      return now!=null&&before!=null&&Number.isFinite(now-before)?[{teamNumber:peer.teamNumber,delta:now-before}]:[];
    });
    const ranked=[...peerDeltas].sort((a,b)=>b.delta-a.delta);
    const rank=ranked.findIndex((item)=>item.teamNumber===team.teamNumber)+1;
    return [{key:definition.key,label:definition.label,delta,rank,fieldSize:ranked.length} satisfies Change];
  });
  const best=teamChanges.filter((item)=>item.delta>0).sort((a,b)=>b.delta-a.delta)[0]??null;
  const worst=teamChanges.filter((item)=>item.delta<0).sort((a,b)=>a.delta-b.delta)[0]??null;
  const formatRank=(item:Change|null)=>{
    if(!item||!item.rank||!item.fieldSize)return "Not enough comparable event history";
    const topPercent=Math.max(1,Math.round(item.rank/item.fieldSize*100));
    return `#${item.rank} of ${item.fieldSize} · top ${topPercent}%`;
  };
  const movement=(item:Change|null,kind:"gain"|"loss")=>{
    if(!item)return kind==="gain"?"No measured EPA dimension increased since the previous event.":"No measured EPA dimension decreased since the previous event.";
    return <><span className="font-bold">{item.label}</span> {kind==="gain"?"increased":"decreased"} by <strong className="tabular-nums">{Math.abs(item.delta).toFixed(1)} EPA</strong></>;
  };
  return <section className="space-y-3">
    <div className="flex justify-end"><span className="text-xs text-slate-500">Changes since the previous official event</span></div>
    <div className="grid gap-3 md:grid-cols-3">

        <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-900 dark:bg-emerald-950/30">
          <p className="text-xs font-bold uppercase tracking-wide text-emerald-800 dark:text-emerald-300">Biggest gain</p>
          <p className="mt-2 text-sm leading-6 text-slate-800 dark:text-slate-100">{movement(best,"gain")}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50/70 p-4 dark:border-rose-900 dark:bg-rose-950/30">
          <p className="text-xs font-bold uppercase tracking-wide text-rose-800 dark:text-rose-300">Biggest loss</p>
          <p className="mt-2 text-sm leading-6 text-slate-800 dark:text-slate-100">{movement(worst,"loss")}</p>
        </div>
      <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-900">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Comparison with the field</p>
        <div className="mt-3 space-y-3">
          <div><p className="text-xs text-slate-500">Their strongest improvement</p><p className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{best?formatRank(best):"No positive change to rank"}</p><p className="mt-1 text-xs text-slate-500">{best?best.label+" gain":"No EPA category improved."}</p></div>
          <div className="border-t border-slate-200 pt-3 dark:border-slate-700"><p className="text-xs text-slate-500">Their largest decline</p><p className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{worst?formatRank(worst):"No negative change to rank"}</p><p className="mt-1 text-xs text-slate-500">{worst?worst.label+" decline":"No EPA category declined."}</p></div>
        </div>
      </div>
    </div>
  </section>;
}

function TeamSnapshot({teams,selectedTeam,onSelect,team,insight,data}:{teams:TeamAnalyticsRow[];selectedTeam:string;onSelect:(value:string)=>void;team:TeamAnalyticsRow|undefined;insight:TeamInsight|null;data:EventAnalyticsResponse}) {
  return <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-950 sm:p-5">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-xs font-bold uppercase tracking-wide text-blue-700">Team investigation</p><h2 className="mt-1 text-lg font-bold text-slate-900 dark:text-slate-100">Team overview</h2><p className="mt-1 text-sm text-slate-500">A quick read on the team's standing. Detailed model and match analysis follows below.</p></div>
      <label className="block w-full max-w-sm text-xs font-semibold text-slate-600 dark:text-slate-300">Select team
        <select value={selectedTeam} onChange={(event)=>onSelect(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900">
          <option value="">Choose a team…</option>
          {teams.map((item)=><option key={item.teamKey} value={String(item.teamNumber)}>{item.teamNumber} · {item.name}</option>)}
        </select>
      </label>
    </div>
    {!selectedTeam ? <p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-600 dark:bg-slate-900 dark:text-slate-300">Choose a team to see its event standing, season development, comparable-alliance context, and matches worth reviewing.</p> : !team || !insight ? <p className="mt-4 text-sm text-slate-500">The team overview is still being assembled from the available event data.</p> : <>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
        <h3 className="text-xl font-black text-slate-950 dark:text-slate-50">{team.teamNumber} · {team.name}</h3>
        <a href={"https://www.thebluealliance.com/team/" + team.teamNumber} target="_blank" rel="noreferrer" className="text-xs font-semibold text-blue-700 hover:underline">Team history on TBA ↗</a>
      </div>
      <div className="mt-4"><TeamPerformanceHeadline data={data} team={team} insight={insight}/></div>
    </>}
  </section>;
}

function TeamModelDetailPanel({team,insight}:{team:TeamAnalyticsRow;insight:TeamInsight}) {
  const change=insight.seasonComparison;
  return <details className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-950">
    <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-800 dark:text-slate-100">Team model details and comparisons</summary>
    <div className="space-y-4 border-t border-slate-100 p-4 dark:border-slate-800">
      <section>
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Estimated scoring profile</h3>
        <p className="mt-1 text-xs text-slate-500">Statbotics EPA estimates, not measured points scored by the robot.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900"><p className="text-xs font-semibold text-slate-500">Overall EPA</p><p className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100">{fmt(team.epa)} <span className="text-xs font-medium">EPA</span></p><p className="text-xs text-slate-500">{team.epaPercentile===null?"Event percentile unavailable":`${Math.round(team.epaPercentile*100)}th percentile at this event`}</p></div>
          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900"><p className="text-xs font-semibold text-slate-500">EPA components</p><div className="mt-2 flex h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">{[team.autoEpa,team.teleopEpa,team.endgameEpa].map((value,index)=>{const total=[team.autoEpa,team.teleopEpa,team.endgameEpa].reduce<number>((sum,item)=>sum+(item??0),0);return <span key={index} className={index===0?"bg-amber-400":index===1?"bg-blue-500":"bg-emerald-500"} style={{width:total>0&&value!==null?`${Math.max(0,value)/total*100}%`:"0%"}}/>;})}</div><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-300"><span>Auto {fmt(team.autoEpa)}</span><span>Teleop {fmt(team.teleopEpa)}</span><span>Endgame {fmt(team.endgameEpa)}</span></div></div>
        </div>
      </section>
      <section>
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Traditional team ratings</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <div><p className="text-xs font-semibold text-slate-500">OPR · Offensive Power Rating</p><p className="mt-1 text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{fmt(team.opr)}</p></div>
          <div><p className="text-xs font-semibold text-slate-500">DPR · Defensive Power Rating</p><p className="mt-1 text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{fmt(team.dpr)}</p></div>
          <div><p className="text-xs font-semibold text-slate-500">CCWM · Contribution to Winning Margin</p><p className="mt-1 text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{fmt(team.ccwm)}</p></div>
        </div>
        <p className="mt-2 text-xs leading-5 text-slate-500">These are separate statistical estimates and should not be treated as directly comparable measurements or proof of individual robot contribution.</p>
      </section>
      {change ? <section className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900"><h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Change since previous event</h3><p className="mt-1 text-sm text-slate-700 dark:text-slate-200">EPA {change.change>0?"increased":change.change<0?"decreased":"was unchanged"} by {fmt(Math.abs(change.change))} points, from {fmt(change.priorEPA)} at {change.priorEvent.name} to {fmt(change.currentEPA)} now.</p><p className="mt-1 text-xs text-slate-500">This was the {change.cohortRank}{change.cohortRank===1?"st":change.cohortRank===2?"nd":change.cohortRank===3?"rd":"th"} largest change among {change.cohortSize} event teams with usable records. EPA is a predictive estimate, not measured scoring improvement.</p></section> : null}
      <section>
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Comparable-alliance results</h3>
        <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">{insight.peerPerformance.interpretation==="insufficient-sample"?"There are not enough comparable results to identify a reliable pattern.":insight.peerPerformance.interpretation==="above-peers"?"Alliances involving this team scored meaningfully above other alliances of similar predicted strength.":insight.peerPerformance.interpretation==="below-peers"?"Alliances involving this team scored meaningfully below other alliances of similar predicted strength.":"Alliance results involving this team were broadly similar to other alliances of comparable predicted strength."}</p>
        <details className="mt-2 rounded-lg bg-slate-50 dark:bg-slate-900"><summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300">Show sample and comparison method</summary><div className="space-y-1 border-t border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-700"><p>{insight.peerPerformance.teamMatches} team matches and {insight.peerPerformance.peerAllianceCount} comparison results.</p><p>Team-involved alliance average: {fmt(insight.peerPerformance.teamMeanResidual)} points above/below prediction.</p><p>Comparable-alliance average: {fmt(insight.peerPerformance.peerMeanResidual)} points above/below prediction.</p><p>Difference between averages: {fmt(insight.peerPerformance.difference)} points.</p><p>Comparable alliances were within ±20% of the selected alliance's pre-match combined EPA. Alliance results cannot isolate one robot's contribution.</p></div></details>
      </section>
    </div>
  </details>;
}

function EliminationShiftPanel({analysis}:{analysis:TeamMatchAnalysis}) {
  const result = analysis.eliminationShift;
  const recurring = result.interpretation === "recurring-negative-shift";
  const label = result.interpretation === "no-elimination-matches" ? "No elimination matches played"
    : result.interpretation === "single-event-shift" ? "Single-event comparison"
    : recurring ? "Recurring decline signal"
    : result.interpretation === "insufficient-history" ? "More match data needed" : "No consistent decline detected";
  const negativeCount = result.events.filter((item) => item.shift < 0).length;
  const positiveCount = result.events.filter((item) => item.shift > 0).length;
  const unchangedCount = result.events.length - negativeCount - positiveCount;
  const signed = (value:number|null) => value === null ? "—" : (value > 0 ? "+" : "") + fmt(value) + " pts";
  return <section className="mt-4 space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-2xl">
        <h4 className="text-base font-bold text-slate-900">Elimination performance shift</h4>
        <p className="mt-1 text-sm leading-6 text-slate-600">Did the team's alliance results move up or down from qualification matches to elimination matches at the same events?</p>
      </div>
      <span className={"rounded-full px-3 py-1.5 text-xs font-bold " + (recurring ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-700")}>{label}</span>
    </div>

    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <p className="text-xs font-semibold text-slate-500">Typical event shift</p>
        <p className="mt-1 text-2xl font-black tabular-nums text-slate-950">{signed(result.medianShift)}</p>
        <p className="mt-1 text-xs text-slate-500">Median change, qual. → elims.</p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <p className="text-xs font-semibold text-slate-500">Average event shift</p>
        <p className="mt-1 text-2xl font-black tabular-nums text-slate-950">{signed(result.meanShift)}</p>
        <p className="mt-1 text-xs text-slate-500">Mean change across events</p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <p className="text-xs font-semibold text-slate-500">Events with a decline</p>
        <p className="mt-1 text-2xl font-black tabular-nums text-slate-950">{negativeCount} <span className="text-sm font-semibold text-slate-400">/ {result.eligibleEventCount}</span></p>
        <p className="mt-1 text-xs text-slate-500">Negative shift, regardless of size</p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <p className="text-xs font-semibold text-slate-500">Recurrence test</p>
        <p className="mt-1 text-2xl font-black tabular-nums text-slate-950">{fmt(result.signTestPValue, 3)}</p>
        <p className="mt-1 text-xs text-slate-500">p-value; smaller means stronger evidence of a recurring pattern</p>
      </div>
    </div>

    {result.events.length ? <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-sm font-bold text-slate-900">Event-by-event comparison</h5>
        <p className="text-xs text-slate-500">{result.events.length} qualifying events · {positiveCount} increased · {negativeCount} decreased · {unchangedCount} unchanged</p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {result.events.map((item) => {
          const declined = item.shift < 0;
          return <article key={item.event.key} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <a className="font-bold text-blue-700 hover:underline" href={"https://www.thebluealliance.com/event/" + item.event.key} target="_blank" rel="noreferrer">{item.event.name}</a>
              <span className={"rounded-md px-2 py-1 text-xs font-bold tabular-nums " + (declined ? "bg-rose-50 text-rose-800" : "bg-emerald-50 text-emerald-800")}>{declined ? "Down " : "Up "}{signed(item.shift)}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Qualifications</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-slate-900">{signed(item.qualificationMeanResidual)}</p>
                <p className="mt-1 text-xs text-slate-500">{item.qualificationMatches} matches</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Eliminations</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-slate-900">{signed(item.eliminationMeanResidual)}</p>
                <p className="mt-1 text-xs text-slate-500">{item.eliminationMatches} matches</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
              <p className="text-xs text-slate-500">Shift uncertainty: ±{fmt(item.shiftStandardError)} pts (1 SE)</p>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold text-slate-500">Matches:</span>
                {item.qualificationMatchKeys.map((key) => <a key={key} className="rounded bg-slate-100 px-1.5 py-1 font-semibold text-blue-700 hover:bg-blue-50" href={"https://www.thebluealliance.com/match/" + key} target="_blank" rel="noreferrer" title="Open qualification match">{matchCode(key)}</a>)}
                {item.eliminationMatchKeys.map((key) => <a key={key} className="rounded bg-amber-50 px-1.5 py-1 font-semibold text-amber-800 hover:bg-amber-100" href={"https://www.thebluealliance.com/match/" + key} target="_blank" rel="noreferrer" title="Open elimination match">{matchCode(key)}</a>)}
              </div>
            </div>
          </article>;
        })}
      </div>
    </> : <p className="rounded-xl border border-dashed border-slate-300 p-4 text-sm leading-6 text-slate-600">No event has enough usable data yet. Each event needs at least {result.minimumQualificationMatchesPerEvent} scored qualification matches and {result.minimumEliminationMatchesPerEvent} scored elimination matches with predictions.</p>}

    <div className="rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">
      <p><span className="font-semibold text-slate-800">How to read this:</span> residual = actual alliance score − predicted alliance score. A negative shift means the alliance scored closer to (or further below) its prediction in eliminations than in qualifications. It does not mean the team necessarily scored fewer points.</p>
      <p className="mt-1">The recurrence test only counts declines larger than one estimated standard error, and only at events where qualification residuals were above zero. p-values are not proof of cause. Partner and opponent strength are not adjusted for, and alliance results cannot isolate one robot's contribution. Treat this as exploratory evidence, not a team label.</p>
    </div>
  </section>;
}
function ResidualPatternPanel({analysis}:{analysis:TeamMatchAnalysis}) {
  const result = analysis.residualPattern;
  const total = result.negativeEventCount + result.positiveEventCount;
  const direction = result.positiveEventCount > result.negativeEventCount ? "above" : result.negativeEventCount > result.positiveEventCount ? "below" : "mixed";
  const status = total === 0 ? "Not enough data"
    : total === 1 ? (direction === "above" ? "Above baseline at this event" : direction === "below" ? "Below baseline at this event" : "At baseline")
    : direction === "above" ? `Above baseline at ${result.positiveEventCount} of ${total} events`
    : direction === "below" ? `Below baseline at ${result.negativeEventCount} of ${total} events`
    : "Mixed results across events";
  const meanGap = result.meanTeamResidual;
  return <section className="mt-3 rounded-lg border border-slate-200 p-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h4 className="text-sm font-bold text-slate-900">Score vs expected alliance performance</h4>
        <p className="mt-1 max-w-3xl text-xs text-slate-600">Did the team's alliances score more or fewer points than expected, compared with similarly rated opposing alliances?</p>
      </div>
      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">{status}</span>
    </div>
    {total > 0 ? <>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] text-slate-500">Average advantage vs baseline</p><p className="mt-1 text-xl font-bold tabular-nums">{meanGap===null?"—":`${meanGap>0?"+":""}${fmt(meanGap)} pts`}</p></div>
        <div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] text-slate-500">Events above baseline</p><p className="mt-1 text-xl font-bold tabular-nums">{result.positiveEventCount} of {total}</p></div>
        <div className="col-span-2 rounded-lg bg-slate-50 p-3 sm:col-span-1"><p className="text-[11px] text-slate-500">Events below baseline</p><p className="mt-1 text-xl font-bold tabular-nums">{result.negativeEventCount} of {total}</p></div>
      </div>
      <div className="mt-3 space-y-2">
        {result.events.map((item)=>{
          const gap=item.teamMeanResidual-item.baselineMeanResidual;
          return <div key={item.event.key} className="flex flex-col gap-1 rounded-lg border border-slate-100 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0"><p className="text-sm font-semibold text-slate-800">{item.event.name}</p><p className="text-xs text-slate-500">{item.teamMatches} matches · Team alliance residual {fmt(item.teamMeanResidual)} · Peer baseline {fmt(item.baselineMeanResidual)}</p></div>
            <span className={`shrink-0 text-sm font-bold tabular-nums ${gap>=0?"text-emerald-700":"text-rose-700"}`}>{gap>0?"+":""}{fmt(gap)} pts {gap>=0?"above":"below"}</span>
          </div>;
        })}
      </div>
      <p className="mt-2 text-[11px] text-slate-500">Positive means the team's alliances outscored the matched baseline; negative means they scored below it. This is an alliance-level comparison, not an individual-robot rating. Small event counts describe direction, not statistical certainty.</p>
    </> : <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
      <p className="font-semibold">Not enough usable match data yet.</p>
      <p className="mt-1">An event needs at least 3 scored team matches and 2 strength-matched opponent samples.</p>
      {result.diagnostics?.length ? <div className="mt-2 space-y-1">{result.diagnostics.map((item)=><div key={item.event.key} className="flex flex-wrap justify-between gap-x-3"><span>{item.event.name}</span><span className="font-mono tabular-nums">{item.matches} matches · {item.scoredMatches} scored · {item.teamResidualSamples} team residuals · {item.baselineAllianceSamples}/2 peer samples</span></div>)}</div> : null}
    </div>}
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
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-bold text-slate-900">Same-match EPA comparison</h3><p className="text-xs text-slate-500">Pre-match ratings for both teams in the exact same matches · {shared.length} shared matches</p></div><div className="flex flex-wrap gap-3 text-xs"><span className="flex items-center gap-1"><i className="h-0.5 w-4 bg-slate-500"/>{nameA} · solid line</span><span className="flex items-center gap-1"><i className="h-0.5 w-4 border-t-2 border-dashed border-slate-400"/>{nameB} · dashed line</span><span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-rose-600"/>Red alliance</span><span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-blue-600"/>Blue alliance</span></div></div>
    <svg viewBox="0 0 900 260" role="img" aria-label={`Pre-match EPA comparison between ${nameA} and ${nameB} across ${shared.length} common matches`} className="mt-3 w-full">
      {[0,1,2,3].map((n)=><g key={n}><line x1="48" x2="858" y1={40+n*56} y2={40+n*56} stroke="var(--insights-gridline)" strokeDasharray="3 4"/><text x="40" y={44+n*56} textAnchor="end" fontSize="10" fill="var(--insights-muted)">{(max-range*n/3).toFixed(0)}</text></g>)}
      <polyline points={lineA} fill="none" stroke="#64748b" strokeWidth="2.5" strokeLinejoin="round"/><polyline points={lineB} fill="none" stroke="#94a3b8" strokeWidth="2.5" strokeDasharray="5 4" strokeLinejoin="round"/>
      {shared.map(({a,b},i)=><g key={a.matchKey}><circle cx={x(i)} cy={y(a.preEPA as number)} r="4" fill={a.alliance==="red"?"#e11d48":"#2563eb"}><title>{a.event.name} · {a.matchLabel} · {nameA}: {a.preEPA?.toFixed(2)} EPA · {a.alliance} alliance</title></circle><circle cx={x(i)} cy={y(b.preEPA as number)} r="4" fill={b.alliance==="red"?"#e11d48":"#2563eb"}><title>{b.event.name} · {b.matchLabel} · {nameB}: {b.preEPA?.toFixed(2)} EPA · {b.alliance} alliance</title></circle></g>)}
      <text x="50" y="246" fontSize="10" fill="var(--insights-muted)">{shared[0].a.matchLabel}</text><text x={x(mid)} y="246" textAnchor="middle" fontSize="10" fill="var(--insights-muted)">{shared[mid].a.matchLabel}</text><text x="850" y="246" textAnchor="end" fontSize="10" fill="var(--insights-muted)">{shared[shared.length-1].a.matchLabel}</text>
    </svg>
    <p className="text-[10px] text-slate-500">Comparing ratings at the same point in the season controls for match and event timing. EPA is a model estimate, not a direct measure of robot performance. Hover points for exact values.</p>
  </section>;
}

function TeamMatchEpaLedger({analysis,name}:{analysis:TeamMatchAnalysis;name:string}) {
  const matches=[...analysis.matches].sort((a,b)=>a.event.startDate.localeCompare(b.event.startDate)||a.event.key.localeCompare(b.event.key)||a.matchKey.localeCompare(b.matchKey,undefined,{numeric:true}));
  const epaValues=matches.flatMap((m)=>[m.preEPA,m.postEPA]).filter((v):v is number=>v!==null);
  const epaMin=Math.min(0,...epaValues), epaMax=Math.max(1,...epaValues);
  const epaRange=Math.max(1,epaMax-epaMin);
  const x=(i:number)=>matches.length<2?450:54+i*800/(matches.length-1);
  const y=(v:number)=>214-(v-epaMin)/epaRange*166;
  const residuals=matches.filter((m)=>m.residual!==null);
  const residualMax=Math.max(1,...residuals.map((m)=>Math.abs(m.residual??0)));
  const componentRows=[{key:"auto_epa",actual:"auto",label:"Auto"},{key:"teleop_epa",actual:"teleop",label:"Teleop"},{key:"endgame_epa",actual:"endgame",label:"Endgame"}];
  const componentSeries=componentRows.map((row)=>({...row,points:matches.flatMap((m,i)=>{const estimate=m.alliancePreComponents[row.key],actual=m.actualComponents[row.actual];return typeof estimate==="number"&&typeof actual==="number"?[{i,estimate,actual,match:m}]:[];})}));
  const eventGroups=matches.reduce<{key:string;label:string;items:{match:TeamMatchRow;index:number}[]}[]>((groups,match,index)=>{
    let group=groups[groups.length-1];
    if(!group||group.key!==match.event.key){group={key:match.event.key,label:match.event.name,items:[]};groups.push(group);}
    group.items.push({match,index});return groups;
  },[]);
  const eventBoundaries=eventGroups.slice(1).map((group)=>x(group.items[0].index)-800/(Math.max(1,matches.length-1))/2);
  const allianceColor=(alliance:"red"|"blue")=>alliance==="red"?"#e11d48":"#2563eb";
  const componentChartWidth=Math.max(900,componentSeries.reduce((max,s)=>Math.max(max,s.points.length*54+80),900));
  return <section className="min-w-0 rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-bold text-slate-900">{name}</h3><p className="text-xs text-slate-500">Season match analysis · {matches.length} matches across {analysis.eventCount} events</p></div><a className="text-xs font-semibold text-slate-600 hover:underline" href={`https://www.thebluealliance.com/team/${analysis.team}/${analysis.year}`} target="_blank" rel="noreferrer">TBA history ↗</a></div>
    <div className="mt-4 rounded-lg border border-slate-100 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-sm font-semibold text-slate-800">EPA progression</h4><p className="text-[11px] text-slate-500">Every point is labeled by match; vertical dividers mark event changes. Pre-match is dashed gray; post-match markers use the team's alliance color for that match.</p></div><div className="flex gap-3 text-[11px]"><span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-slate-400"/>Pre-match</span><span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-slate-700"/>Post-match</span></div></div>
      <div className="mt-2 overflow-x-auto"><svg viewBox={`0 0 900 ${matches.length>18?310:270}`} role="img" aria-label={`${name} EPA progression across ${matches.length} matches`} className="w-full min-w-[900px] overflow-visible">
        {[0,1,2,3].map((n)=><g key={n}><line x1="48" x2="866" y1={40+n*56} y2={40+n*56} stroke="var(--insights-gridline)" strokeDasharray="3 4"/><text x="40" y={44+n*56} textAnchor="end" fontSize="10" fill="var(--insights-muted)">{(epaMax-(epaRange*n/3)).toFixed(0)}</text></g>)}
        {eventBoundaries.map((boundary,index)=><g key={index}><line x1={boundary} x2={boundary} y1="24" y2="246" stroke="var(--insights-muted)" strokeWidth="1.5" strokeDasharray="4 3"/><text x={boundary+5} y="17" fontSize="10" fill="var(--insights-muted)">{eventGroups[index+1].label}</text></g>)}
        {eventGroups.length>0&&<text x={Math.max(60,x(eventGroups[0].items[0].index))} y="17" fontSize="10" fill="var(--insights-muted)">{eventGroups[0].label}</text>}
        {eventGroups.map((group)=><g key={group.key}>
          <polyline points={group.items.flatMap(({match,index})=>match.preEPA===null?[]:[`${x(index)},${y(match.preEPA)}`]).join(" ")} fill="none" stroke="#94a3b8" strokeWidth="2" strokeDasharray="5 4"/>
          <polyline points={group.items.flatMap(({match,index})=>match.postEPA===null?[]:[`${x(index)},${y(match.postEPA)}`]).join(" ")} fill="none" stroke="#64748b" strokeWidth="2.5" strokeLinejoin="round"/>
        </g>)}
        {matches.map((m,i)=><g key={m.matchKey}>
          {m.preEPA!==null&&<circle cx={x(i)} cy={y(m.preEPA)} r="3.5" fill="#94a3b8"><title>{m.event.name} · {m.matchLabel}: pre-match EPA {m.preEPA.toFixed(2)}</title></circle>}
          {m.postEPA!==null&&<circle cx={x(i)} cy={y(m.postEPA)} r="4.5" fill={allianceColor(m.alliance)} stroke="white" strokeWidth="1"><title>{m.event.name} · {m.matchLabel}: post-match EPA {m.postEPA.toFixed(2)}{m.sharedAllianceUpdate?" · shared alliance update":""} · {m.alliance} alliance</title></circle>}
          <text transform={`translate(${x(i)-2},258) rotate(-48)`} textAnchor="end" fontSize={matches.length>35?"7":"9"} fill="var(--insights-muted)">{m.matchLabel}</text>
        </g>)}
      </svg></div>
      <p className="text-[10px] text-slate-500">Post-match marker colors indicate the selected team's alliance in that match (red or blue). Each point is a model rating snapshot, not a direct measurement of robot contribution. Hover points for exact values.</p>
    </div>
    <div className="mt-3 rounded-lg border border-slate-100 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-sm font-semibold text-slate-800">Alliance score prediction residual</h4><p className="text-[11px] text-slate-500">Actual score minus predicted score; positive means the alliance scored above prediction</p></div><span className="text-xs text-slate-500">n={residuals.length}</span></div>
      <div className="mt-2 overflow-x-auto"><svg viewBox={`0 0 900 ${Math.max(190,Math.ceil(residuals.length/30)*35+150)}`} role="img" aria-label={`${name} alliance score prediction residuals by match`} className="w-full min-w-[900px]">
        <line x1="48" x2="866" y1="88" y2="88" stroke="var(--insights-muted)" strokeWidth="1.5"/>
        {residuals.map((m,i)=>{const step=812/Math.max(1,residuals.length);const barW=Math.max(4,Math.min(16,step-3));const bx=50+i*step;const h=Math.abs(m.residual??0)/residualMax*65;const positive=(m.residual??0)>=0;return <g key={m.matchKey}><rect x={bx} y={positive?88-h:88} width={barW} height={Math.max(1,h)} rx="1" fill={positive?"#0d9488":"#e11d48"}><title>{m.event.name} · {m.matchLabel}: predicted {fmt(m.predicted)}, actual {fmt(m.actual)}, residual {fmt(m.residual)}</title></rect><text transform={`translate(${bx+barW/2},164) rotate(-55)`} textAnchor="end" fontSize="8" fill="var(--insights-muted)">{m.matchLabel}</text></g>;})}
      </svg></div>
      <div className="flex gap-4 text-[10px] text-slate-500"><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-teal-600"/>Above prediction</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-rose-600"/>Below prediction</span></div>
    </div>
    <div className="mt-3 rounded-lg border border-slate-100 p-3">
      <h4 className="text-sm font-semibold text-slate-800">Alliance component estimates vs actual</h4>
      <p className="text-[11px] text-slate-500">Each match is a paired comparison: pre-match alliance EPA estimate versus TBA's recorded alliance component score. These are alliance totals, not individual team scores.</p>
      <div className="mt-3 space-y-5">{componentSeries.map((series)=><div key={series.key} className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold text-slate-800">{series.label}</span><span className="text-[10px] text-slate-400">n={series.points.length}</span></div>
        {series.points.length?<div className="overflow-x-auto"><svg viewBox={`0 0 ${componentChartWidth} 250`} role="img" aria-label={`${series.label} alliance EPA estimates versus actual scores by match`} className="w-full min-w-[900px]">
          {[0,1,2,3].map((n)=>{const max=Math.max(1,...series.points.flatMap((p)=>[p.estimate,p.actual]));return <g key={n}><line x1="55" x2={componentChartWidth-20} y1={190-n*48} y2={190-n*48} stroke="var(--insights-gridline)" strokeDasharray="3 4"/><text x="48" y={194-n*48} textAnchor="end" fontSize="10" fill="var(--insights-muted)">{(max*n/3).toFixed(0)}</text></g>;})}
          {series.points.map((point,index)=>{const max=Math.max(1,...series.points.flatMap((p)=>[p.estimate,p.actual]));const step=(componentChartWidth-90)/Math.max(1,series.points.length);const bw=Math.min(17,step*0.34);const base=60+index*step;const h1=point.estimate/max*140,h2=point.actual/max*140;return <g key={point.match.matchKey}><rect x={base} y={190-h1} width={bw} height={h1} rx="2" fill={allianceColor(point.match.alliance)}><title>{point.match.event.shortName??point.match.event.name} · {point.match.matchLabel}: EPA estimate {point.estimate.toFixed(1)}</title></rect><rect x={base+bw+2} y={190-h2} width={bw} height={h2} rx="2" fill="#94a3b8"><title>{point.match.event.shortName??point.match.event.name} · {point.match.matchLabel}: actual {point.actual.toFixed(1)}</title></rect><text transform={`translate(${base+bw},210) rotate(-45)`} textAnchor="end" fontSize="9" fill="var(--insights-muted)">{point.match.matchLabel}</text></g>;})}
        </svg></div>:<p className="text-xs text-slate-500">No complete {series.label.toLowerCase()} estimate/outcome pairs.</p>}
      </div>)}</div>
      <div className="flex flex-wrap gap-4 text-[10px] text-slate-500"><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-rose-600"/>EPA estimate · red alliance</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-blue-600"/>EPA estimate · blue alliance</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-slate-400"/>Actual score</span></div>
      <p className="mt-2 text-[10px] text-slate-500">Hover bars for match values. Alliance color identifies which alliance the selected team played on; the gray bar is the actual alliance score.</p>
    </div>
    <details className="mt-3 rounded-lg border border-slate-200"><summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-600">Inspect match records ({matches.length})</summary><div className="max-h-96 overflow-auto"><table className="w-full min-w-[760px] text-xs"><thead className="sticky top-0 bg-white text-left text-slate-400"><tr><th className="p-2">Match</th><th>Partners / opponents</th><th>Pre → post EPA</th><th>Predicted / actual</th><th>Residual</th><th>Win chance</th></tr></thead><tbody>{matches.map((m)=><tr key={m.matchKey} className="border-t border-slate-100"><td className="p-2"><a className="font-semibold text-slate-800 hover:underline" href={`https://www.thebluealliance.com/match/${m.matchKey}`} target="_blank" rel="noreferrer">{m.matchLabel}</a><span className="block text-[10px] text-slate-400">{m.event.name}</span></td><td><div className="flex flex-wrap gap-x-1"><span className={m.alliance==="red"?"font-semibold text-rose-700":"font-semibold text-blue-700"}>{allianceTeamNumbers(analysis.team,m.partners).join(", ")}</span><span className="text-slate-400">/</span><span className={m.alliance==="red"?"font-semibold text-blue-700":"font-semibold text-rose-700"}>{m.opponents.join(", ")||"—"}</span></div></td><td className="tabular-nums">{fmt(m.preEPA,2)} → {fmt(m.postEPA,2)}</td><td className="tabular-nums">{fmt(m.predicted)} / {fmt(m.actual)}</td><td className="tabular-nums">{fmt(m.residual)}</td><td className="tabular-nums">{m.teamWinProbability===null?"—":`${(m.teamWinProbability*100).toFixed(0)}%`}</td></tr>)}</tbody></table></div></details>
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
      const label=a.event.name;
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
    return typeof value==="number"&&(!best||value>best.value)?{label:item.event.name,value}:best;
  },null);
  const smallest=events.reduce<{label:string;value:number}|null>((best,item)=>{
    const value=item.statbotics?.epa?.total_points;
    return typeof value==="number"&&(!best||value<best.value)?{label:item.event.name,value}:best;
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
        return <tr key={item.event.key} className="border-b border-slate-100"><th className="py-2 text-left font-medium">{item.event.name}</th><td className="tabular-nums">{fmt(epa)}</td><td className="tabular-nums">{change===null?"—":(change>0?"+":"")+fmt(change)}</td><td>{eventQual?`${eventQual.wins??0}-${eventQual.losses??0}`:"—"}</td><td>{fmt(eventQual?.rps_per_match,2)}</td><td>{eventQual?.rank!=null?`${eventQual.rank}${eventQual.num_teams?` / ${eventQual.num_teams}`:""}`:"—"}</td></tr>;
      })}</tbody></table>
      {events.length>0&&<div className="mt-3 grid gap-2 sm:grid-cols-2">{events.map((item)=><div key={item.event.key} className="rounded-lg bg-slate-50 p-2"><p className="text-xs font-semibold text-slate-700">{item.event.name}</p><div className="mt-1 flex flex-wrap gap-1">{Object.entries(item.statbotics?.epa?.breakdown??{}).filter(([key,value])=>typeof value==="number"&&!/^comp_\d+_epa$/.test(key)).map(([key,value])=><span key={key} className="rounded bg-white px-2 py-1 text-[10px] text-slate-600">{key.replaceAll("_"," ")} <strong>{fmt(value)}</strong></span>)}</div></div>)}</div>}
      </div>
    </details>
  </section>;
}
function HistoryMetric({label,value}:{label:string;value:string}) {
  return <div className="rounded-lg border border-slate-200 bg-white p-2.5"><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 text-lg font-black tabular-nums text-slate-900">{value}</p></div>;
}
function EventEpaBars({events,color}:{events:TeamSeasonHistory["events"];color:string}) {
  const points=events.flatMap((item)=>typeof item.statbotics?.epa?.total_points==="number"?[{label:item.event.name,value:item.statbotics.epa.total_points}]:[]);
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
  const teamByKey=new Map(data.teams.map((team)=>[team.teamKey,team]));
  const rankings=data.rankings?.rankings??[];
  const completedMatches=data.matches.filter(({match})=>match.alliances.red.score>=0&&match.alliances.blue.score>=0).length;
  const rankedTeams=rankings.map((ranking)=>({ranking,team:teamByKey.get(ranking.team_key)})).filter((item)=>item.team).sort((a,b)=>a.ranking.rank-b.ranking.rank);
  const epaTeams=[...data.teams].sort((a,b)=>(b.epa??-Infinity)-(a.epa??-Infinity));
  const qualificationLeader=rankedTeams[0];
  const highestEpaTeam=epaTeams.find((team)=>team.epa!==null);
  const leadFinding=data.findings[0];
  const cohortRecords=data.seasonCohort?.records??[];
  const componentValue=(breakdown:Record<string,number>|undefined,keys:string[])=>{
    for(const key of keys)if(typeof breakdown?.[key]==="number"&&Number.isFinite(breakdown[key]))return breakdown[key];
    return null;
  };
  const trend=(current:number|null,prior:number|null)=>{
    if(current===null||prior===null)return <span aria-label="Previous event comparison unavailable" className="text-slate-400">—</span>;
    if(current===prior)return <span aria-label="No change since last event" className="text-slate-400">−</span>;
    const increased=current>prior;
    return <svg aria-label={increased?"Increased since last event":"Decreased since last event"} role="img" className={"inline size-4 "+(increased?"text-emerald-600":"text-rose-600")} viewBox="0 0 20 20" fill="none"><path d={increased?"m5 12 5-5 5 5":"m5 8 5 5 5-5"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>;
  };
  const insights=data.teamInsights??[];
  const improved=insights.filter((item)=>item.seasonComparison).sort((a,b)=>(b.seasonComparison?.change??0)-(a.seasonComparison?.change??0)).slice(0,5);
  const declined=insights.filter((item)=>item.seasonComparison).sort((a,b)=>(a.seasonComparison?.change??0)-(b.seasonComparison?.change??0)).slice(0,5);
  const residuals=data.teams.flatMap((team)=>{const values=data.allianceResults.filter((item)=>item.teamKeys.includes(team.teamKey)&&item.actual!==null&&item.residual!==null).map((item)=>item.residual as number);if(values.length<3)return [];const mean=values.reduce((sum,value)=>sum+value,0)/values.length;const variance=values.reduce((sum,value)=>sum+(value-mean)*(value-mean),0)/Math.max(1,values.length-1);const margin=1.96*Math.sqrt(variance/values.length);return Math.abs(mean)>margin?[{team,mean,margin,count:values.length}]:[];});
  const over=residuals.filter((item)=>item.mean>0).sort((a,b)=>(b.mean-b.margin)-(a.mean-a.margin)).slice(0,5);
  const under=residuals.filter((item)=>item.mean<0).sort((a,b)=>(a.mean+a.margin)-(b.mean+b.margin)).slice(0,5);
  const performanceStatus=(teamKey:string)=>{
    const residual=residuals.find((item)=>item.team.teamKey===teamKey);
    if(residual?.mean&&residual.mean>0)return {label:"Overperforming",tone:"bg-emerald-50 text-emerald-800"};
    if(residual?.mean&&residual.mean<0)return {label:"Underperforming",tone:"bg-rose-50 text-rose-800"};
    return {label:"Within expectations",tone:"bg-slate-100 text-slate-700"};
  };
  const movement=(items:TeamInsight[],empty:string)=><ol className="space-y-2">{items.length?items.map((item,index)=>{const cmp=item.seasonComparison!;return <li key={item.teamNumber} className="flex items-center justify-between gap-3 border-b border-slate-100 pb-2 last:border-0"><div className="min-w-0"><span className="mr-2 text-xs text-slate-400">#{index+1}</span>{teamNumberLink(item.teamNumber)}</div><div className="shrink-0 text-right"><span className="block text-[10px] text-slate-500">Since Last Event</span><strong className={"tabular-nums "+(cmp.change>=0?"text-emerald-700":"text-rose-700")}>{cmp.change>0?"+":""}{fmt(cmp.change)}</strong></div></li>; }):<li className="text-sm text-slate-500">{empty}</li>}</ol>;
  const residualList=(items:typeof residuals,empty:string)=><ol className="space-y-2">{items.length?items.map((item,index)=><li key={item.team.teamKey} className="flex items-center justify-between gap-3 border-b border-slate-100 pb-2 last:border-0"><div className="min-w-0"><span className="mr-2 text-xs text-slate-400">#{index+1}</span>{teamNumberLink(item.team.teamNumber)}</div><strong className={"shrink-0 tabular-nums "+(item.mean>0?"text-emerald-700":"text-rose-700")}>{item.mean>0?"+":""}{fmt(item.mean)} pts</strong></li>):<li className="text-sm text-slate-500">{empty}</li>}</ol>;
  return <div className="space-y-5">
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex flex-wrap items-end justify-between gap-2"><div><p className="text-xs font-bold uppercase tracking-wide text-blue-700">Event overview</p><h2 className="mt-1 text-lg font-bold text-slate-900">The competitive picture</h2><p className="mt-1 text-sm text-slate-500">Who is gaining ground, who is falling behind expectations, and where the model is being surprised.</p></div><span className="text-xs text-slate-500">{data.teams.length} teams · {completedMatches}/{data.matchCount} matches scored</span></div>
      <div className="mt-4 rounded-lg bg-slate-50 p-3">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">At a glance</h3>
        <ul className="mt-2 grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          <li><span className="font-semibold text-slate-900">Qualification leader:</span> {qualificationLeader ? `Team ${qualificationLeader.team!.teamNumber} · rank ${qualificationLeader.ranking.rank}` : "Official rankings are not available yet."}</li>
          <li><span className="font-semibold text-slate-900">Highest available EPA:</span> {highestEpaTeam ? `Team ${highestEpaTeam.teamNumber} · ${fmt(highestEpaTeam.epa)} EPA` : "No team EPA estimates are available yet."}</li>
          <li><span className="font-semibold text-slate-900">Match coverage:</span> {completedMatches} scored of {data.matchCount} scheduled matches; {data.collection.processedMatchCount} processed for analysis.</li>
          <li><span className="font-semibold text-slate-900">Review signal:</span> {leadFinding ? leadFinding.title : "No findings currently meet the review thresholds."}</li>
        </ul>
      </div>
      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <Panel title="EPA Change from Last Event" description="Change in Statbotics event EPA total-points estimate versus each team's most recent preceding official event."><div className="grid gap-4 sm:grid-cols-2"><div><p className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-700">Largest EPA Gain</p>{movement(improved,"No usable prior-event comparisons yet.")}</div><div><p className="mb-2 text-xs font-bold uppercase tracking-wide text-rose-700">Largest EPA Decline</p>{movement(declined,"No usable prior-event comparisons yet.")}</div></div><p className="mt-3 text-[11px] leading-5 text-slate-500">This is movement in a predictive model estimate, not measured scoring improvement. Teams without a preceding event record are omitted.</p></Panel>
        <Panel title="Outside the margin of error" description="Teams whose mean alliance score residual is clearly above or below zero in their event matches."><div className="grid gap-4 sm:grid-cols-2"><div><p className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-700">Overperformers</p>{residualList(over,"No teams currently clear the positive uncertainty band.")}</div><div><p className="mb-2 text-xs font-bold uppercase tracking-wide text-rose-700">Underperformers</p>{residualList(under,"No teams currently clear the negative uncertainty band.")}</div></div><p className="mt-3 text-[11px] leading-5 text-slate-500">Mean alliance residual with an approximate 95% confidence margin (1.96 × standard error); at least three scored samples. Alliance residuals include partners and opponents and cannot isolate one robot's contribution.</p></Panel>
      </div>
    </section>
    <details className="rounded-xl border border-slate-200 bg-white">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-700">Detailed standings, team ratings, and prediction diagnostics</summary>
      <div className="space-y-4 p-4">
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Qualification standings" description="Every ranked team at this event, ordered by official TBA qualification rank. Performance labels compare alliance score residuals with the event sample's uncertainty margin."><div className="overflow-x-auto">{rankedTeams.length?<table className="w-full min-w-[480px] text-sm"><thead className="bg-white"><tr className="border-b text-left text-[11px] uppercase tracking-wide text-slate-400"><th className="py-2 pr-3">Rank</th><th className="py-2 pr-3">Team</th><th className="py-2 pr-3">Record</th><th className="py-2">Performance</th></tr></thead><tbody>{rankedTeams.map(({ranking,team})=>{const status=performanceStatus(team!.teamKey);return <tr key={ranking.team_key} className="border-b border-slate-100"><td className="py-2 pr-3 font-bold tabular-nums">{ranking.rank}</td><th className="py-2 pr-3 text-left">{teamNumberLink(team!.teamNumber)}</th><td className="py-2 pr-3 tabular-nums">{ranking.record?ranking.record.wins+"–"+ranking.record.losses+"–"+ranking.record.ties:"—"}</td><td className="py-2"><span className={"inline-flex whitespace-nowrap rounded-full px-2 py-1 text-[10px] font-semibold "+status.tone}>{status.label}</span></td></tr>;})}</tbody></table>:<p className="text-sm text-slate-500">Official qualification standings are not available yet.</p>}</div><p className="mt-3 text-xs text-slate-500">Residuals are alliance-level and cannot isolate a team's contribution.</p></Panel>
      <Panel title="Event EPA by team" description="All event teams with their current EPA component estimates. Chevrons compare each component with the team's most recent preceding official event.">
        {epaTeams.length?<div className="overflow-x-auto"><table className="w-full min-w-[680px] table-fixed text-sm"><colgroup><col className="w-[18%]"/><col className="w-[12%]"/><col className="w-[16%]"/><col className="w-[18%]"/><col className="w-[18%]"/><col className="w-[18%]"/></colgroup>
          <thead className="bg-white"><tr className="border-b text-left text-[10px] uppercase tracking-wide text-slate-400"><th className="py-2 pr-2">Team</th><th className="py-2 px-1 text-right">EPA</th><th className="py-2 px-1 text-right">Event percentile</th><th className="py-2 px-1 text-right">Auto</th><th className="py-2 px-1 text-right">Teleop</th><th className="py-2 pl-1 text-right">Endgame</th></tr></thead>
          <tbody>{epaTeams.map((team)=>{
            const currentRecord=cohortRecords.find((record)=>record.teamNumber===team.teamNumber&&record.event.key===data.event.key);
            const priorRecord=cohortRecords.filter((record)=>record.teamNumber===team.teamNumber&&record.status==="ready"&&record.event.startDate<data.event.start_date).sort((a,b)=>b.event.startDate.localeCompare(a.event.startDate))[0];
            const currentAuto=componentValue(currentRecord?.breakdown,["auto_epa","auto","auto_points"])??team.autoEpa;
            const currentTeleop=componentValue(currentRecord?.breakdown,["teleop_epa","teleop","teleop_points"])??team.teleopEpa;
            const currentEndgame=componentValue(currentRecord?.breakdown,["endgame_epa","endgame","endgame_points"])??team.endgameEpa;
            const priorAuto=componentValue(priorRecord?.breakdown,["auto_epa","auto","auto_points"]);
            const priorTeleop=componentValue(priorRecord?.breakdown,["teleop_epa","teleop","teleop_points"]);
            const priorEndgame=componentValue(priorRecord?.breakdown,["endgame_epa","endgame","endgame_points"]);
            const total=currentRecord?.epaTotal??team.epa;
            return <tr key={team.teamKey} className="border-b border-slate-100"><th className="py-2 pr-2 text-left">{teamNumberLink(team.teamNumber)}</th><td className="px-1 text-right font-semibold tabular-nums">{fmt(total)}</td><td className="px-1 text-right tabular-nums">{percentileLabel(team.epaPercentile)}</td><td className="px-1 text-right tabular-nums"><span className="inline-flex items-center justify-end gap-1">{fmt(currentAuto)}{trend(currentAuto,priorAuto)}</span></td><td className="px-1 text-right tabular-nums"><span className="inline-flex items-center justify-end gap-1">{fmt(currentTeleop)}{trend(currentTeleop,priorTeleop)}</span></td><td className="pl-1 text-right tabular-nums"><span className="inline-flex items-center justify-end gap-1">{fmt(currentEndgame)}{trend(currentEndgame,priorEndgame)}</span></td></tr>;
          })}</tbody>
        </table></div>:<p className="text-sm text-slate-500">EPA records are not available yet.</p>}
      </Panel>
    </div>
    <Panel title="Prediction diagnostics" description="How well Statbotics predictions aligned with actual alliance scores and match winners in the loaded sample."><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><QualityMetric label="Mean absolute error" value={fmt(data.predictionStats.meanAbsoluteError)} unit="pts" detail="Average size of an alliance score miss"/><QualityMetric label="Root mean square error" value={fmt(data.predictionStats.rootMeanSquareError)} unit="pts" detail="Weights larger misses more heavily"/><QualityMetric label="Within ±25 points" value={data.predictionStats.allianceCount?(data.predictionStats.within25Count/data.predictionStats.allianceCount*100).toFixed(1)+"%":"—"} detail={data.predictionStats.within25Count+" of "+data.predictionStats.allianceCount+" alliance scores"}/><QualityMetric label="Winner accuracy" value={data.predictionStats.winPredictionAccuracy===null?"—":(data.predictionStats.winPredictionAccuracy*100).toFixed(1)+"%"} detail={data.predictionStats.winPredictionCount+" decided matches"}/></div><div className="mt-4 rounded-lg bg-slate-50 p-3"><p className="text-xs font-semibold text-slate-600">Prediction bias</p><p className="mt-1 text-xl font-black tabular-nums">{data.predictionStats.meanResidual===null?"—":(data.predictionStats.meanResidual>0?"+":"")+fmt(data.predictionStats.meanResidual)+" pts"}</p><p className="text-xs text-slate-500">Positive means predictions tended low; negative means predictions tended high. Residual spread: {fmt(data.residualStats.standardDeviation)} pts across {data.residualStats.sampleSize} alliance results.</p></div></Panel>
      </div>
    </details>
  </div>;
}


function ReviewQueue({findings}:{findings:ReviewFinding[]}) {
  const [reviewed,setReviewed] = useState<string[]>([]);
  const [dismissed,setDismissed] = useState<string[]>([]);
  const visible = findings.filter((finding)=>!dismissed.includes(finding.id));
  return <Panel title="Suggested review" description="Evidence-backed leads worth a human scout investigating. These are not robot-performance verdicts. Review and dismissal state is local to this browser in this prototype.">
    <div className="mb-3 flex flex-wrap gap-3 text-xs text-slate-500"><span>{visible.length} findings</span><span>{reviewed.length} reviewed</span><span>{dismissed.length} dismissed</span></div>
    {!visible.length ? <p className="text-sm text-slate-500">No findings met the current prototype thresholds in this sample.</p> : <div className="space-y-3">{visible.map((finding)=><article key={finding.id} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase text-slate-700">{finding.category === "score-residual" ? "Anomalous Score" : finding.category === "penalty-frequency" ? "Penalty Frequency" : "Repeated Alliance Pattern"}</span><span className="text-xs text-slate-400">{finding.sampleCoverage} sample coverage · n={finding.sampleSize}</span></div><div className="mt-2 flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-slate-500">{finding.subject}</p>{finding.category === "score-residual" ? <a className="text-xs font-semibold text-blue-700 hover:underline" href={"https://www.thebluealliance.com/match/" + finding.id.split(":")[1]} target="_blank" rel="noreferrer">Open match ↗</a> : null}</div><h3 className="mt-1 font-bold text-slate-900">{finding.title}</h3><p className="mt-1 text-sm text-slate-600">{finding.description}</p><ul className="mt-2 list-disc pl-5 text-xs text-slate-500">{finding.evidence.map((item)=><li key={item}>{item}</li>)}</ul><p className="mt-2 text-xs font-medium text-slate-700">Suggested follow-up: {finding.suggestedAction}</p><div className="mt-3 flex gap-2"><button onClick={()=>setReviewed((current)=>current.includes(finding.id)?current:[...current,finding.id])} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold">{reviewed.includes(finding.id)?"Reviewed":"Mark reviewed"}</button><button onClick={()=>setDismissed((current)=>[...current,finding.id])} className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100">Dismiss</button></div></article>)}</div>}
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
        return <a key={item.matchKey+item.color} href={`https://www.thebluealliance.com/match/${item.matchKey}`} target="_blank" rel="noreferrer" className="block rounded-lg border border-slate-100 p-3 transition-colors hover:border-slate-400 hover:bg-slate-50">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><span className="font-semibold text-slate-900">{item.matchLabel}</span><span className={`ml-2 text-xs font-semibold uppercase ${item.color==="red"?"text-rose-700":"text-blue-700"}`}>{item.color} alliance</span><p className="mt-0.5 text-xs text-slate-500"><span className={item.color==="red"?"font-semibold text-rose-700":"font-semibold text-blue-700"}>{item.teamKeys.map((key)=>key.replace(/^frc/i,"")).join(" · ")}</span></p></div>
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
