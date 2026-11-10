"use client";

import Link from "next/link";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/20/solid";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EventAnalyticsResponse, ReviewFinding, TeamAnalyticsRow, TeamInsight } from "@/lib/insights/types";
import { formatTeamNumber, matchCode, matchShortName } from "@/lib/tba/formatters";
import type { StatboticsTeamEvent, StatboticsTeamYear } from "@/lib/statbotics/types";

type TeamSeasonHistory = { team: { nickname?: string | null; name?: string | null }; season: StatboticsTeamYear | null; events: { event: { key: string; name: string; short_name?: string | null; start_date: string; week?: number | null }; statbotics: StatboticsTeamEvent | null; status: "ready" | "unavailable" }[] };
type TeamMatchRow = { matchKey:string; matchLabel:string; compLevel:string; event:{key:string;name:string;shortName?:string|null;startDate:string}; partners:string[]; opponents:string[]; alliance:"red"|"blue"; predicted:number|null; actual:number|null; residual:number|null; opponentPredicted:number|null; opponentActual:number|null; opponentResidual:number|null; alliancePreEPATotal:number|null; alliancePreComponents:Record<string,number>; actualComponents:Record<string,number>; redWinProbability:number|null; teamWinProbability:number|null; rpOutcomes:{key:string;predicted:number|null;achieved:boolean|null}[]; won:boolean|null; preEPA:number|null; postEPA:number|null; deltaEPA:number|null; preComponents:Record<string,number>; postComponents:Record<string,number>; allianceDeltaSpread:number|null; sharedAllianceUpdate:boolean; statboticsAvailable:boolean } ;
type TeamMatchAnalysis = { team:number; year:number; eventCount:number; matchCount:number; anomalySummary:{matchesWithAnomalies:number;matchesEvaluated:number;frequency:number|null;allianceUnderperformance:number;allianceOverperformance:number;opponentAnomalies:number;highConfidenceMisses:number;baseline:string}; anomalies:{matchKey:string;matchLabel:string;event:{key:string;name:string;startDate:string};compLevel:string;partners:string[];opponents:string[];alliance:string;residual:number|null;opponentResidual:number|null;teamWinProbability:number|null;won:boolean|null;kinds:string[];reasons:string[];highConfidenceMiss:boolean}[]; summary:{matches:number;wins:number;losses:number;ties:number;winRate:number|null;meanResidual:number|null;meanAbsoluteError:number|null;rootMeanSquareError:number|null;meanMatchEPAChange:number|null;epaStart:number|null;epaEnd:number|null;rp:{key:string;sampleSize:number;accuracy:number|null;brier:number|null}[]}; eventSummaries:{event:{key:string;name:string;shortName?:string|null;startDate:string};matches:number;wins:number;losses:number;ties:number;winRate:number|null;meanResidual:number|null;meanAbsoluteError:number|null;rootMeanSquareError:number|null;meanMatchEPAChange:number|null;epaStart:number|null;epaEnd:number|null}[]; phaseSummaries:{phase:string;matches:number;wins:number;losses:number;ties:number;winRate:number|null;meanResidual:number|null;meanAbsoluteError:number|null;rootMeanSquareError:number|null;meanMatchEPAChange:number|null;epaStart:number|null;epaEnd:number|null;rp:{key:string;sampleSize:number;accuracy:number|null;brier:number|null}[]}[];eliminationShift:{eliminationMatchCount:number;eligibleEventCount:number;negativeEventCount:number;positiveEventCount:number;directionalEventCount:number;meanShift:number|null;medianShift:number|null;signTestPValue:number|null;minimumQualificationMatchesPerEvent:number;minimumEliminationMatchesPerEvent:number;interpretation:"insufficient-history"|"no-elimination-matches"|"single-event-shift"|"recurring-negative-shift"|"no-established-negative-shift";events:{event:{key:string;name:string;shortName?:string|null;startDate:string};qualificationMatches:number;eliminationMatches:number;qualificationMeanResidual:number|null;eliminationMeanResidual:number|null;shift:number;shiftStandardError:number;qualificationMatchKeys:string[];eliminationMatchKeys:string[]}[]};residualPattern:{eligibleEventCount:number;negativeEventCount:number;positiveEventCount:number;meanTeamResidual:number|null;signTestPValue:number|null;positiveSignTestPValue:number|null;interpretation:"insufficient-history"|"single-event-below-baseline"|"single-event-above-baseline"|"recurring-below-baseline"|"recurring-above-baseline"|"no-established-pattern";events:{event:{key:string;name:string;shortName?:string|null;startDate:string};teamMatches:number;baselineAllianceSamples:number;teamMeanResidual:number;baselineMeanResidual:number;baselineStandardDeviation:number;belowOneSigma:number;aboveOneSigma:number;belowBaseline:boolean;matchKeys:string[]}[];diagnostics?:{event:{key:string;name:string;shortName?:string|null;startDate:string};matches:number;scoredMatches:number;teamResidualSamples:number;opponentResidualSamples:number;baselineAllianceSamples:number;eligible:boolean}[]};matches:TeamMatchRow[];collection:{state:string;statboticsMatches:number;totalMatches:number;updatedAt:number}};
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
const ordinal = (value: number) => {
  const lastTwo = value % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? "th"
    : value % 10 === 1 ? "st" : value % 10 === 2 ? "nd" : value % 10 === 3 ? "rd" : "th";
  return `${value}${suffix}`;
};
const percentileLabel = (value: number | null) => value === null ? "—" : ordinal(Math.round(value * 100));
function predictionClassification(redProbability: number | null): string | null {
  if (redProbability === null || !Number.isFinite(redProbability) || redProbability < 0 || redProbability > 1) return null;
  if (redProbability >= 0.8) return "Strong Red";
  if (redProbability >= 0.6) return "Lean Red";
  if (redProbability >= 0.4) return "Toss-up";
  if (redProbability >= 0.2) return "Lean Blue";
  return "Strong Blue";
}

function allianceTeamNumbers(teamNumber: number, otherTeams: string[]): string[] {
  return [...new Set([String(teamNumber), ...otherTeams])];
}

function teamLinkForNumber(teamNumber:number,name:string):ReactNode {
  return <Link href={`/team/${teamNumber}`} className="font-semibold text-slate-800 hover:text-blue-700">{teamNumber} · {name}</Link>;
}

function teamNumberLink(teamNumber:number):ReactNode {
  return <Link href={`/team/${teamNumber}`} className="font-semibold text-slate-800 hover:text-blue-700">{teamNumber}</Link>;
}

export default function EventAnalyticsDashboard({ eventKey, eventName, websocketStatus, websocketStale }: { eventKey: string; eventName: string; websocketStatus: "connected" | "disconnected" | "connecting"; websocketStale: boolean }) {
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
  const [matchAnalysisRefreshKey, setMatchAnalysisRefreshKey] = useState(0);
  const lastMatchAnalysisRefreshKey = useRef(0);

  const load = useCallback(async (forceRefresh = false) => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const refreshQuery = forceRefresh ? "?refresh=1" : "";
      const response = await fetch(`/api/insights/event/${encodeURIComponent(eventKey)}${refreshQuery}`, { cache: "no-store" });
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
    void load();
  }, [load]);

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
    setMatchAnalysisA(null);
    setMatchAnalysisLoading(true); setMatchAnalysisError(null);
    const shouldRefresh = matchAnalysisRefreshKey > lastMatchAnalysisRefreshKey.current;
    if (shouldRefresh) lastMatchAnalysisRefreshKey.current = matchAnalysisRefreshKey;
    const query = `year=${data.event.year}${shouldRefresh ? "&refresh=1" : ""}`;
    fetch(`/api/insights/team/${teamA}/matches?${query}`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("Team season investigation is temporarily unavailable");
      const result = await response.json();
      if (active) setMatchAnalysisA(result as TeamMatchAnalysis);
    }).catch((error) => {
      if (active) { setMatchAnalysisA(null); setMatchAnalysisError(error instanceof Error ? error.message : "Unable to load team investigation"); }
    }).finally(() => { if (active) setMatchAnalysisLoading(false); });
    return () => { active = false; };
  }, [teamA,data?.event.year,matchAnalysisRefreshKey]);

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
          <p className="mt-2 flex items-center gap-2 text-xs font-medium text-slate-500"><span className={`h-2 w-2 rounded-full ${websocketStatus === "connected" ? "bg-emerald-500" : websocketStatus === "connecting" ? "bg-amber-400" : "bg-slate-300"}`} />{websocketStatus === "connected" ? "Live event feed connected" : websocketStatus === "connecting" ? "Connecting to live event feed…" : "Live event feed disconnected"}{websocketStale ? " · live feed delayed" : ""}</p>
        </div>
        <div className="flex flex-wrap gap-2"><button type="button" onClick={() => { if (teamA) setMatchAnalysisRefreshKey((value) => value + 1); void load(true); }} disabled={loading} className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50">{loading ? "Loading…" : "Refresh data"}</button><Link href={`/event/${eventKey}`} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">Event details</Link></div>
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
              The bulk Statbotics request failed: {data.collection.statboticsFetchError}. TBA schedule and scores remain available. Use Refresh data to retry the model-data request; model-dependent metrics may be incomplete until it succeeds.
            </p> : unavailable > 0 ? <p className="mt-2 text-xs leading-5 text-amber-800">
              {unavailable} scheduled match(es) have no corresponding record in the Statbotics event collection. TBA match results are still retained. Statbotics may not have published predictions for these matches yet, or may not provide records for that match type. Use Refresh data to request another Statbotics collection.
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
            {matchAnalysisA ? <TeamAnalysisTabs analysis={matchAnalysisA} records={data.matches} eventKey={eventKey} timezone={data.event.timezone ?? null} name={selectedA?.name ?? `Team ${teamA}`} /> : !matchAnalysisLoading && !matchAnalysisError && teamA ? <p className="text-sm text-slate-500">No season match analysis is available yet.</p> : null}
          </section>}
          {tab === "qualification" && <QualificationAnalysisPanel data={data} />}
          {tab === "playoffs" && <PlayoffAnalysisPanel data={data} />}
          {tab === "alliances" && <PlayoffAllianceAnalysisPanel data={data} />}
          {tab === "scouting" && <section className="space-y-4">
            <ReviewQueue data={data} />
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
  return <Panel title="Matches worth reviewing" description="Season-wide review leads involving this team. A flag may concern this team's alliance, the opposing alliance, or an unexpected win-probability result; it is not an explanation of cause.">
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Matches involving this team flagged</p>
        <p className="mt-1 text-3xl font-black tabular-nums text-slate-950 dark:text-slate-50">{summary.matchesWithAnomalies}<span className="ml-2 text-sm font-semibold text-slate-500">/ {summary.matchesEvaluated}</span></p>
        <p className="mt-1 text-xs text-slate-500">At least one team-side, opponent-side, or prediction flag</p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">High-confidence losses</p>
        <p className="mt-1 text-3xl font-black tabular-nums text-slate-950 dark:text-slate-50">{summary.highConfidenceMisses}</p>
        <p className="mt-1 text-xs text-slate-500">The model gave the alliance at least an 80% chance to win, but it lost</p>
      </div>
    </div>
    <div className="mt-3 grid gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700 sm:grid-cols-3">
      <div><p className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{summary.allianceUnderperformance}</p><p className="text-xs text-slate-500">Our alliance unusually below prediction</p></div>
      <div><p className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{summary.allianceOverperformance}</p><p className="text-xs text-slate-500">Our alliance unusually above prediction</p></div>
      <div><p className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{summary.opponentAnomalies}</p><p className="text-xs text-slate-500">Opposing alliance anomaly</p></div>
    </div>
    <p className="mt-2 text-[11px] leading-5 text-slate-500">{summary.baseline} High-confidence losses are counted separately. Alliance anomaly flags require at least 4 scored observations for that side's season baseline; the team and opposing-alliance baselines are evaluated independently.</p>
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
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Season results</h3><p className="mt-1 text-xs text-slate-500">{name} · {analysis.matchCount} matches across {analysis.eventCount} official events</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{s.wins} wins · {s.losses} losses{s.ties?` · ${s.ties} ties`:""}</span></div>
    <div className="mt-4 grid gap-3 sm:grid-cols-3">
      <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-900"><p className="text-xs font-semibold text-slate-500">Alliance win rate</p><p className="mt-1 text-2xl font-black tabular-nums text-slate-950 dark:text-slate-50">{rate(s.winRate)}</p><p className="mt-1 text-xs text-slate-500">Across matches involving this team</p></div>
      <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-900"><p className="text-xs font-semibold text-slate-500">Mean absolute prediction error</p><p className="mt-1 text-2xl font-black tabular-nums text-slate-950 dark:text-slate-50">{fmt(s.meanAbsoluteError)} <span className="text-sm font-semibold">pts</span></p><p className="mt-1 text-xs text-slate-500">Average absolute difference for the full alliance</p></div>
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
          {analysis.eventSummaries.length?<><div role="tablist" aria-label="Season events" className="mt-3 flex flex-wrap gap-2">{analysis.eventSummaries.map((item)=><button key={item.event.key} type="button" role="tab" aria-selected={activeEvent?.event.key===item.event.key} onClick={()=>setSelectedEvent(item.event.key)} className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${activeEvent?.event.key===item.event.key?"border-blue-200 bg-blue-50 text-blue-800 dark:border-slate-200 dark:bg-slate-200 dark:text-slate-900":"border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300"}`}>{item.event.name}</button>)}</div>
          {activeEvent?<div role="tabpanel" className="mt-3 grid gap-3 sm:grid-cols-3"><div><p className="text-xs text-slate-500">Alliance record</p><p className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{activeEvent.wins}–{activeEvent.losses}–{activeEvent.ties}</p></div><div><p className="text-xs text-slate-500">Win rate</p><p className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{rate(activeEvent.winRate)}</p></div><div><p className="text-xs text-slate-500">Mean absolute error</p><p className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{fmt(activeEvent.meanAbsoluteError)} pts</p></div></div>:null}</>:<p className="mt-3 text-sm text-slate-500">No event-level match summaries are available.</p>}
        </div>
      </div>
    </details>
    <ResidualPatternPanel analysis={analysis}/>
    <p className="mt-3 text-xs text-slate-500">Score prediction metrics describe the six-team alliance result, not an individual robot's contribution. EPA is a model estimate, not a measured score.</p>
  </section>;
}

function PhasePerformancePanel({analysis,phase}:{analysis:TeamMatchAnalysis;phase:"qualification"|"elimination"}) {
  const isQual=phase==="qualification";
  const phaseItems=analysis.phaseSummaries.filter((item)=>isQual?item.phase==="qm":["ef","qf","sf","f"].includes(item.phase));
  const phaseMatches=phaseItems.reduce((sum,item)=>sum+item.matches,0);
  const weighted=(key:"meanResidual"|"meanAbsoluteError",items=phaseItems)=>{
    const available=items.filter((item)=>item[key]!==null);
    const count=available.reduce((sum,item)=>sum+item.matches,0);
    return count?available.reduce((sum,item)=>sum+(item[key]??0)*item.matches,0)/count:null;
  };
  const residualItems=phaseItems.filter((item)=>item.rootMeanSquareError!==null);
  const residualCount=residualItems.reduce((sum,item)=>sum+item.matches,0);
  const phaseData=phaseItems.length?{
    matches:phaseMatches,
    wins:phaseItems.reduce((sum,item)=>sum+item.wins,0),
    losses:phaseItems.reduce((sum,item)=>sum+item.losses,0),
    ties:phaseItems.reduce((sum,item)=>sum+item.ties,0),
    winRate:(phaseItems.reduce((sum,item)=>sum+item.wins,0)+phaseItems.reduce((sum,item)=>sum+item.losses,0))>0
      ?phaseItems.reduce((sum,item)=>sum+item.wins,0)/(phaseItems.reduce((sum,item)=>sum+item.wins+item.losses,0)):null,
    meanResidual:weighted("meanResidual"),
    meanAbsoluteError:weighted("meanAbsoluteError"),
    rootMeanSquareError:residualCount?Math.sqrt(residualItems.reduce((sum,item)=>sum+(item.rootMeanSquareError??0)**2*item.matches,0)/residualCount):null,
    epaStart:phaseItems.find((item)=>item.epaStart!==null)?.epaStart??null,
    epaEnd:[...phaseItems].reverse().find((item)=>item.epaEnd!==null)?.epaEnd??null,
    rp:["energized","supercharged","traversal"].map((key)=>{
      const values=phaseItems.flatMap((item)=>item.rp.filter((rp)=>rp.key===key));
      const accuracyValues=values.filter((item)=>item.accuracy!==null);
      const brierValues=values.filter((item)=>item.brier!==null);
      const sampleSize=values.reduce((sum,item)=>sum+item.sampleSize,0);
      const accuracyCount=accuracyValues.reduce((sum,item)=>sum+item.sampleSize,0);
      const brierCount=brierValues.reduce((sum,item)=>sum+item.sampleSize,0);
      return {key,sampleSize,accuracy:accuracyCount?accuracyValues.reduce((sum,item)=>sum+(item.accuracy??0)*item.sampleSize,0)/accuracyCount:null,brier:brierCount?brierValues.reduce((sum,item)=>sum+(item.brier??0)*item.sampleSize,0)/brierCount:null};
    }).filter((item)=>item.sampleSize>0),
  }:null;
  const title=isQual?"Qualification matches":"Elimination matches";
  if(!phaseData) return <section><h3 className="text-base font-bold text-slate-900 dark:text-slate-100">{title}</h3><p className="mt-2 text-sm text-slate-500">No {isQual?"qualification":"elimination"} match sample is available yet.</p></section>;
  return <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-950">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-base font-bold text-slate-900 dark:text-slate-100">{title}</h3><p className="mt-1 text-xs text-slate-500">{phaseData.matches} matches across the official season</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">{phaseData.wins}–{phaseData.losses}–{phaseData.ties} alliance record</span></div>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900"><p className="text-xs font-semibold text-slate-500">Alliance win rate</p><p className="mt-1 text-2xl font-black tabular-nums text-slate-950 dark:text-slate-50">{phaseData.winRate===null?"—":`${(phaseData.winRate*100).toFixed(1)}%`}</p><p className="mt-1 text-xs text-slate-500">Results from {isQual?"qualification":"elimination"} matches only</p></div>
      <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900"><p className="text-xs font-semibold text-slate-500">Mean absolute prediction error</p><p className="mt-1 text-2xl font-black tabular-nums text-slate-950 dark:text-slate-50">{fmt(phaseData.meanAbsoluteError)} <span className="text-sm font-semibold">pts</span></p><p className="mt-1 text-xs text-slate-500">Average absolute miss for the full alliance</p></div>
    </div>
    <details className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700"><summary className="cursor-pointer px-3 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200">Additional model metrics</summary><div className="grid gap-3 border-t border-slate-100 p-3 dark:border-slate-700 sm:grid-cols-3"><div><p className="text-xs text-slate-500">Prediction direction (actual − predicted)</p><p className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{phaseData.meanResidual===null?"—":(phaseData.meanResidual>0?"+":"")+fmt(phaseData.meanResidual)+" pts"}</p></div><div><p className="text-xs text-slate-500">Large misses weighted more (RMSE)</p><p className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{fmt(phaseData.rootMeanSquareError)} pts</p></div><div><p className="text-xs text-slate-500">Model EPA at first → last match</p><p className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{fmt(phaseData.epaStart,2)} → {fmt(phaseData.epaEnd,2)}</p></div></div></details>
    {isQual&&phaseData.rp.length ? <details className="mt-2 rounded-lg border border-slate-200 dark:border-slate-700"><summary className="cursor-pointer px-3 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200">Ranking-point prediction accuracy</summary><div className="grid grid-cols-3 gap-2 border-t border-slate-100 p-3 dark:border-slate-700">{phaseData.rp.map((item)=><div key={item.key} className="rounded-lg bg-slate-50 p-2 dark:bg-slate-900"><p className="text-[10px] font-semibold uppercase text-slate-500">{item.key} RP</p><p className="text-sm font-bold text-slate-900 dark:text-slate-100">{item.accuracy===null?"—":`${(item.accuracy*100).toFixed(1)}%`}</p><p className="text-[10px] text-slate-500">{item.sampleSize} matches · Brier {fmt(item.brier,3)}</p></div>)}</div></details>:null}
    <p className="mt-3 text-xs text-slate-500">{isQual?"Alliance residuals include this team's two alliance partners, not the opposing alliance; they cannot isolate this team's contribution.":"Elimination samples are usually smaller; treat these results as descriptive, not definitive."}</p>
  </section>;
}

function QualificationAnalysisPanel({data}:{data:EventAnalyticsResponse}) {
  const matches=data.matches.filter(({match})=>match.comp_level==="qm").sort((a,b)=>a.match.match_number-b.match.match_number);
  const analysis=data.qualificationAnalysis;
  const calibration=analysis?.predictionCalibration;
  const score=analysis?.scorePrediction;
  const penalties=analysis?.penalties;
  const anomalies=data.qualificationAnomalies??[];
  const scoreFlags=anomalies.filter((item)=>item.outsideExpectedRange);
  const highConfidenceMisses=calibration?.highConfidenceMisses??[];
  const modelUpsets=matches.flatMap(({match,statbotics})=>{
    const probability=statbotics?.pred?.red_win_prob;
    const winner=match.winning_alliance;
    if(typeof probability!=="number"||probability<0||probability>1||
      (winner!=="red"&&winner!=="blue")||match.alliances.red.score<0||match.alliances.blue.score<0) return [];
    const favorite=probability>=0.5?"red" as const:"blue" as const;
    const favoriteProbability=Math.max(probability,1-probability);
    return winner!==favorite&&favoriteProbability>=0.6
      ?[{matchKey:match.key,matchLabel:matchShortName(match,data.event.playoff_type),favorite,favoriteProbability}]
      :[];
  }).sort((a,b)=>b.favoriteProbability-a.favoriteProbability);
  const fmtPct=(value:number|null|undefined)=>value===null||value===undefined?"—":(value*100).toFixed(1)+"%";
  const signed=(value:number|null)=>value===null?"—":(value>0?"+":"")+fmt(value)+" pts";
  return <div className="space-y-4">
    <Panel title="Qualification takeaways" description="Event-wide findings from completed qualification matches. Calibration, score error, and high-penalty counts are separate signals.">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <QualityMetric label="Winner prediction accuracy" value={fmtPct(calibration?.accuracy)} detail={(calibration?.matchCount??0)+" matches with prediction and winner"}/>
        <QualityMetric label="Underdog wins" value={String(calibration?.underdogWins??0)} detail="Matches won by the side with under 50% predicted chance"/>
        <QualityMetric label="Score MAE" value={fmt(score?.meanAbsoluteError)} unit="pts" detail={(score?.allianceCount??0)+" predicted alliance scores"}/>
        <QualityMetric label="High-confidence misses" value={String(highConfidenceMisses.length)} detail="Predicted winner had at least 80% probability but lost"/>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-slate-100 p-3">
          <h3 className="text-sm font-semibold text-slate-900">Unexpected outcomes</h3>
          {highConfidenceMisses.length?<ul className="mt-2 space-y-1 text-sm">{highConfidenceMisses.map((item)=><li key={item.matchKey} className="flex justify-between gap-3"><a className="font-semibold text-slate-800 hover:underline" href={"https://www.thebluealliance.com/match/"+item.matchKey} target="_blank" rel="noreferrer">{item.matchLabel}</a><span className="text-right text-slate-500">{item.predictedWinner} favored · {fmtPct(item.probability)}</span></li>)}</ul>:<p className="mt-2 text-sm text-slate-500">No high-confidence winner misses in the available sample.</p>}
          <p className="mt-2 text-xs text-slate-500">Score anomalies are independent: {scoreFlags.length} alliance score residuals fell outside the event-calibrated range.</p>
        </div>
        <div className="rounded-lg border border-slate-100 p-3">
          <h3 className="text-sm font-semibold text-slate-900">Score prediction bias</h3>
          <p className="mt-1 text-xs text-slate-500">Residual = actual − predicted. Positive means the model tended to predict too low.</p>
          <p className="mt-2 text-2xl font-black tabular-nums text-slate-900">{signed(score?.meanResidual??null)}</p>
          <p className="mt-1 text-xs text-slate-500">RMSE {fmt(score?.rootMeanSquareError)} pts · separate from whether the model picked the winner.</p>
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-slate-100 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">Model upsets</h3>
          <span className="text-xs text-slate-500">Favorite had at least 60% predicted win probability</span>
        </div>
        {modelUpsets.length ? <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {modelUpsets.map((item)=><li key={item.matchKey} className="flex items-center justify-between gap-3 rounded-md bg-slate-50 px-3 py-2 text-sm">
            <a className="font-semibold text-slate-800 hover:underline" href={"https://www.thebluealliance.com/match/"+item.matchKey} target="_blank" rel="noreferrer">{item.matchLabel}</a>
            <span className="text-right text-xs text-slate-500">{item.favorite} favored · {fmtPct(item.favoriteProbability)} · {item.favorite==="red"?"Blue":"Red"} won</span>
          </li>)}
        </ul> : <p className="mt-2 text-sm text-slate-500">No completed qualification match meets the upset threshold in the available sample.</p>}
        <p className="mt-2 text-[11px] text-slate-500">This is a probability-based upset flag, separate from score-residual anomalies. It does not imply that the model was poorly calibrated overall.</p>
      </div>
    </Panel>
    <details className="rounded-xl border border-slate-200 bg-white p-4">
      <summary className="cursor-pointer text-sm font-semibold text-slate-800">Model calibration details <span className="ml-1 text-xs font-normal text-slate-500">Optional model-quality diagnostic</span></summary>
      <p className="mt-2 text-xs text-slate-500">This helps evaluate whether Statbotics' win probabilities are well calibrated over many matches. It is useful for validating the model, but less actionable for reviewing an individual match.</p>
      {calibration?.bins.length?<div className="mt-3 overflow-x-auto"><table className="w-full min-w-[520px] text-sm"><thead><tr className="border-b text-left text-[10px] uppercase text-slate-400"><th className="py-2">Predicted red chance</th><th>Matches</th><th>Mean predicted</th><th>Actual red wins</th><th>Observed − predicted</th></tr></thead><tbody>{calibration.bins.map((bin)=><tr key={bin.label} className="border-b border-slate-100"><th className="py-2 text-left">{bin.label}</th><td>{bin.count}</td><td>{fmtPct(bin.meanPredicted)}</td><td>{fmtPct(bin.observedRedWinRate)}</td><td>{(bin.calibrationError>0?"+":"")+(bin.calibrationError*100).toFixed(1)+" pp"}</td></tr>)}</tbody></table></div>:<p className="mt-2 text-sm text-slate-500">No calibration data available.</p>}
      <p className="mt-2 text-xs text-slate-500">{calibration?.matchCount??0} matches · accuracy {fmtPct(calibration?.accuracy)} · Brier score {fmt(calibration?.brierScore,3)} (lower is better).</p>
    </details>
    <Panel title="Prediction performance through qualifications" description="Score error is grouped by match order to show whether the model's event-specific accuracy changed over the qualification schedule.">
      {analysis?.progression.length?<div className="grid gap-3 md:grid-cols-3">{analysis.progression.map((period)=><div key={period.label} className="rounded-lg bg-slate-50 p-3"><h3 className="text-sm font-semibold text-slate-800">{period.label}</h3><p className="text-xs text-slate-500">Q{period.firstMatch}–Q{period.lastMatch} · {period.allianceCount} alliance scores</p><p className="mt-2 text-xl font-bold tabular-nums">{fmt(period.meanAbsoluteError)} <span className="text-xs font-medium text-slate-500">MAE pts</span></p><p className="text-xs text-slate-500">Mean residual {signed(period.meanResidual)}</p></div>)}</div>:<p className="text-sm text-slate-500">Not enough completed qualification predictions to compare match periods.</p>}
    </Panel>
    <Panel title="High penalties" description="Alliance penalty points are compared independently across completed qualification matches. A flag identifies the alliance with unusually high credited penalty points; this does not identify which robot committed the foul.">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <QualityMetric label="Matches with penalty data" value={String(penalties?.sampleSize??0)} detail="Completed qualification matches with both alliance totals"/>
        <QualityMetric label="Matches with penalty points" value={String(penalties?.matchesWithPenaltyPoints??0)} detail="At least one penalty point credited"/>
        <QualityMetric label="Total penalty points" value={String(penalties?.totalPenaltyPoints??0)} detail="Red + blue alliance credits"/>
        <QualityMetric label="Unusual-penalty matches" value={String(penalties?.flaggedMatches.length??0)} detail={penalties?.outlierThreshold===null||penalties?.outlierThreshold===undefined?"Outlier test needs at least 10 alliance observations":"Alliance outlier threshold: "+fmt(penalties.outlierThreshold,1)+" points"}/>
      </div>
      {penalties?.flaggedMatches.length?<div className="mt-4 overflow-x-auto"><table className="w-full min-w-[680px] text-sm"><thead><tr className="border-b text-left text-[10px] uppercase text-slate-400"><th className="py-2">Match</th><th>Red count</th><th>Red points</th><th>Blue count</th><th>Blue points</th><th>Combined points</th></tr></thead><tbody>{penalties.flaggedMatches.map((item)=><tr key={item.matchKey} className="border-b border-amber-100 bg-amber-50/60"><th className="py-2 text-left"><a className="font-semibold text-slate-900 hover:underline" href={"https://www.thebluealliance.com/match/"+item.matchKey} target="_blank" rel="noreferrer">{item.matchLabel}</a></th><td>{item.redPenaltyCount??"—"}{item.redFlagged?<span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold text-amber-900">High</span>:null}</td><td>{item.redPenaltyPoints}</td><td>{item.bluePenaltyCount??"—"}{item.blueFlagged?<span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold text-amber-900">High</span>:null}</td><td>{item.bluePenaltyPoints}</td><td className="font-bold">{item.totalPenaltyPoints}</td></tr>)}</tbody></table></div>:<p className="mt-3 text-sm text-slate-500">{(penalties?.sampleSize??0)<10?"Penalty outlier flags will be evaluated after at least 10 usable alliance observations from TBA score breakdowns.":"No completed qualification match had an alliance exceed the event's upper outlier fence."}</p>}
      <p className="mt-2 text-xs text-slate-500">Flag rule: Tukey upper fence (Q3 + 1.5 × IQR); when the middle 50% is tied, values above the median are flagged. Flags are review leads, not judgments about responsibility.</p>
    </Panel>
    <Panel title="Qualification match explorer" description="Inspect every qualification match with prediction context. Match flags are independent: one match can have a winner miss, score anomaly, penalty flag, multiple flags, or none.">
      <MatchAnalysisTable data={data} records={matches} playoff={false}/>
      <p className="mt-3 text-xs text-slate-500">Marker guide: Election-style prediction shows the five win-probability bands; Predicted Win/Loss identifies the favored alliance; High Alliance EPA = combined pre-match alliance EPA in the event top quartile; Large Score Delta = an alliance's absolute actual-minus-predicted score delta in the event top decile; High Penalties = that alliance's credited penalty points exceed the alliance-level outlier threshold. Anomaly and residual markers are review signals, not claims that a score was impossible. Alliance residuals include all three robots and cannot isolate an individual robot's contribution.</p>
    </Panel>
  </div>;
}

type MatchReviewFlag = "model-upset" | "anomalous-score" | "large-residual" | "high-penalties" | "high-alliance-epa";
type MatchFlagSummary = {
  prediction: { label: string; tone: string } | null;
  predictedWinner: "red" | "blue" | null;
  winner: "red" | "blue" | null;
  modelUpset: boolean;
  anomalousScore: boolean;
  largeResidual: { red: boolean; blue: boolean };
  highPenalties: { red: boolean; blue: boolean };
  highAllianceEpa: { red: boolean; blue: boolean };
  reviewFlags: MatchReviewFlag[];
};

function quantile(values:number[],p:number):number|null {
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)];
}

function predictionTone(label:string):string {
  switch(label){
    case "Strong Red": return "bg-rose-800 text-white dark:bg-rose-700";
    case "Lean Red": return "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200";
    case "Toss-up": return "bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100";
    case "Lean Blue": return "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200";
    default: return "bg-blue-800 text-white dark:bg-blue-700";
  }
}

function phaseAnomalyBand(data:EventAnalyticsResponse,compLevel:string):{median:number;margin:number}|null {
  const residuals=data.allianceResults.filter((item)=>item.compLevel.toLowerCase()===compLevel.toLowerCase()&&item.residual!==null).map((item)=>item.residual as number).sort((a,b)=>a-b);
  if(residuals.length<8)return null;
  const median=residuals[Math.floor(residuals.length/2)];
  const deviations=residuals.map((value)=>Math.abs(value-median)).sort((a,b)=>a-b);
  const mad=deviations[Math.floor(deviations.length/2)];
  return {median,margin:Math.max(20,3*1.4826*mad)};
}

function buildMatchFlagSummary(data:EventAnalyticsResponse,record:EventAnalyticsResponse["matches"][number]):MatchFlagSummary {
  const {match,statbotics}=record;
  const redProbability=typeof statbotics?.pred?.red_win_prob==="number"?statbotics.pred.red_win_prob:null;
  const prediction=predictionClassification(redProbability);
  const predictedWinner=redProbability===null||redProbability===0.5?null:redProbability>0.5?"red":"blue";
  const redScore=match.alliances.red.score,blueScore=match.alliances.blue.score;
  const completed=redScore>=0&&blueScore>=0;
  const winner=match.winning_alliance==="red"||match.winning_alliance==="blue"?match.winning_alliance:completed&&redScore!==blueScore?(redScore>blueScore?"red":"blue"):null;
  const favoriteProbability=redProbability===null?null:Math.max(redProbability,1-redProbability);
  const modelUpset=completed&&winner!==null&&predictedWinner!==null&&winner!==predictedWinner&&favoriteProbability!==null&&favoriteProbability>=0.6;
  const matchResults=data.allianceResults.filter((item)=>item.matchKey===match.key);
  const allianceEpaValues=data.allianceResults.flatMap((item)=>item.preEpaTotal===null?[]:[item.preEpaTotal]);
  const highEpaThreshold=allianceEpaValues.length>=8?quantile(allianceEpaValues,0.75):null;
  const highAllianceEpa={
    red:highEpaThreshold!==null&&(matchResults.find((item)=>item.color==="red")?.preEpaTotal??-Infinity)>=highEpaThreshold,
    blue:highEpaThreshold!==null&&(matchResults.find((item)=>item.color==="blue")?.preEpaTotal??-Infinity)>=highEpaThreshold,
  };
  const anomalyBand=phaseAnomalyBand(data,match.comp_level);
  const anomalousScore=anomalyBand!==null&&matchResults.some((item)=>item.residual!==null&&Math.abs(item.residual-anomalyBand.median)>anomalyBand.margin);
  const qualification=match.comp_level.toLowerCase()==="qm";
  const residualMagnitudes=data.allianceResults.flatMap((item)=>item.residual===null?[]:[Math.abs(item.residual)]);
  const largeResidualThreshold=residualMagnitudes.length>=20?quantile(residualMagnitudes,0.9):null;
  const largeResidual={
    red:largeResidualThreshold!==null&&(matchResults.find((item)=>item.color==="red")?.residual!==null&&matchResults.find((item)=>item.color==="red")?.residual!==undefined)&&Math.abs(matchResults.find((item)=>item.color==="red")!.residual!)>=largeResidualThreshold,
    blue:largeResidualThreshold!==null&&(matchResults.find((item)=>item.color==="blue")?.residual!==null&&matchResults.find((item)=>item.color==="blue")?.residual!==undefined)&&Math.abs(matchResults.find((item)=>item.color==="blue")!.residual!)>=largeResidualThreshold,
  };
  const penaltyRow=qualification?data.qualificationAnalysis?.penalties.flaggedMatches.find((item)=>item.matchKey===match.key):undefined;
  const highPenalties={red:penaltyRow?.redFlagged??false,blue:penaltyRow?.blueFlagged??false};
  const reviewFlags:MatchReviewFlag[]=[
    ...(modelUpset?["model-upset" as const]:[]),
    ...(anomalousScore?["anomalous-score" as const]:[]),
    ...(largeResidual.red||largeResidual.blue?["large-residual" as const]:[]),
    ...(highPenalties.red||highPenalties.blue?["high-penalties" as const]:[]),
    ...(highAllianceEpa.red||highAllianceEpa.blue?["high-alliance-epa" as const]:[]),
  ];
  return {prediction:prediction?{label:prediction,tone:predictionTone(prediction)}:null,predictedWinner,winner,modelUpset,anomalousScore,largeResidual,highPenalties,highAllianceEpa,reviewFlags};
}

function MatchAnalysisTable({data,records,playoff}:{data:EventAnalyticsResponse;records:EventAnalyticsResponse["matches"];playoff:boolean}) {
  const teams=new Map(data.teams.map((team)=>[team.teamKey,team]));
  const officialAllianceName=(teamKeys:string[])=>playoff?data.playoffAnalysis?.alliances.find((alliance)=>teamKeys.every((key)=>alliance.teamKeys.includes(key)))?.name??null:null;
  const summaries=new Map(records.map((record)=>[record.match.key,buildMatchFlagSummary(data,record)]));
  const allianceCell=(record:EventAnalyticsResponse["matches"][number],color:"red"|"blue")=>{
    const {match}=record;
    const alliance=match.alliances[color];
    const summary=summaries.get(match.key)!;
    const result=data.allianceResults.find((item)=>item.matchKey===match.key&&item.color===color);
    const actual=alliance.score>=0?alliance.score:null;
    const residual=result?.residual;
    const isWinner=summary.winner===color;
    const isLoser=summary.winner!==null&&summary.winner!==color;
    const isPredictedWinner=summary.predictedWinner===color;
    const isPredictedLoser=summary.predictedWinner!==null&&summary.predictedWinner!==color;
    const isHighEpa=summary.highAllianceEpa[color];
    const winnerSurface=color==="red"?"border-rose-500 border-l-4 bg-rose-100 ring-2 ring-rose-300 dark:border-rose-400 dark:bg-rose-900 dark:ring-rose-400/60":"border-blue-500 border-l-4 bg-blue-100 ring-2 ring-blue-300 dark:border-blue-400 dark:bg-blue-900 dark:ring-blue-400/60";
    const regularSurface="border-slate-200 bg-transparent dark:border-slate-700";
    const allianceTone=color==="red"?"text-rose-950 dark:text-rose-100":"text-blue-950 dark:text-blue-100";
    const darkAllianceFlag=color==="red"?"bg-rose-800 text-white dark:bg-rose-700":"bg-blue-800 text-white dark:bg-blue-700";
    const lightAllianceFlag=color==="red"?"bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200":"bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200";
    return <td key={color} className="py-1.5 pr-2 align-middle"><div className={"grid min-w-0 grid-cols-[minmax(150px,0.9fr)_minmax(0,1.6fr)] gap-x-2 gap-y-1 rounded-md border px-2 py-1.5 "+(isWinner?winnerSurface:regularSurface)}>
      <div className="flex min-w-0 flex-col justify-end">
        {officialAllianceName(alliance.team_keys)?<p className={"mb-0.5 whitespace-nowrap text-[10px] font-bold "+(color==="red"?"text-rose-800 dark:text-rose-200":"text-blue-800 dark:text-blue-200")}>{officialAllianceName(alliance.team_keys)}</p>:null}
        <div className={"flex min-w-0 flex-nowrap gap-x-1.5 whitespace-nowrap text-base font-bold leading-5 tabular-nums "+allianceTone}>{alliance.team_keys.map((key)=><span key={key}>{teams.has(key)?String(teams.get(key)!.teamNumber):formatTeamNumber(key)}</span>)}</div>
      </div>
      <div className="grid min-w-0 grid-cols-4 gap-1 border-l border-slate-200/70 pl-2 text-center dark:border-slate-700">
        <div className="min-w-0"><p className="truncate text-[8px] uppercase tracking-tight text-slate-500 dark:text-slate-400">Win Chance</p><strong className="block truncate text-sm font-semibold leading-5 tabular-nums text-slate-700 dark:text-slate-200">{typeof record.statbotics?.pred?.red_win_prob==="number"?Math.round((color==="red"?record.statbotics.pred.red_win_prob:1-record.statbotics.pred.red_win_prob)*100)+"%":"—"}</strong></div>
        <div className="min-w-0"><p className="truncate text-[8px] uppercase tracking-tight text-slate-500 dark:text-slate-400">Pred. Score</p><strong className="block truncate text-sm font-semibold leading-5 tabular-nums text-slate-800 dark:text-slate-100">{result?.predicted===null||result?.predicted===undefined?"—":fmt(result.predicted,0)}</strong></div>
        <div className="min-w-0"><p className="truncate text-[8px] uppercase tracking-tight text-slate-500 dark:text-slate-400">Score Delta</p><strong className={"block truncate text-sm font-semibold leading-5 tabular-nums "+(residual===null||residual===undefined?"text-slate-400":residual>0?"text-emerald-600 dark:text-emerald-400":residual<0?"text-rose-600 dark:text-rose-400":"text-slate-500 dark:text-slate-400")}>{residual===null||residual===undefined?"—":(residual>0?"+":"")+fmt(residual,0)}</strong></div>
        <div className="min-w-0"><p className="truncate text-[8px] uppercase tracking-tight text-slate-500 dark:text-slate-400">Actual Score</p><strong className={"block truncate text-sm font-bold leading-5 tabular-nums "+(color==="red"?"text-red-600 dark:text-rose-300":"text-blue-600 dark:text-blue-300")}>{actual===null?"—":fmt(actual,0)}</strong></div>
      </div>
      <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-1 border-t border-slate-200/70 pt-1 dark:border-slate-700">
        {isWinner?<span className={"shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-black uppercase leading-3 "+darkAllianceFlag}>Win</span>:isLoser?<span className={"shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-black uppercase leading-3 "+darkAllianceFlag}>Loss</span>:null}
        {isPredictedWinner?<span className={"shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold leading-3 "+lightAllianceFlag}>Predicted Win</span>:null}
        {isPredictedLoser?<span className={"shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold leading-3 "+lightAllianceFlag}>Predicted Loss</span>:null}
        {isHighEpa?<span title="This alliance's combined pre-match EPA is in the top quartile of the event's available alliance estimates." className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold leading-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200">High Alliance EPA</span>:null}
        {summary.largeResidual[color]?<span title="This alliance's absolute actual-minus-predicted score delta is in the event-wide top decile." className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold leading-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200">Large Score Delta</span>:null}
        {summary.highPenalties[color]?<span title="This alliance's credited penalty points exceed the event-level alliance penalty outlier threshold." className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold leading-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200">High Penalties</span>:null}
      </div>
    </div></td>;
  };
  if(!records.length)return <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">{playoff?"No playoff matches are available yet.":"No qualification matches are available yet."}</p>;
  return <div className="overflow-x-auto"><table className="w-full min-w-[820px] table-fixed text-xs"><colgroup><col className="w-[16%]"/><col className="w-[42%]"/><col className="w-[42%]"/></colgroup><thead><tr className="border-b text-left text-[10px] uppercase tracking-wide text-slate-400"><th className="py-2 pr-2">Match flags</th><th className="py-2 pr-2 text-rose-800">Red alliance</th><th className="py-2 text-blue-800">Blue alliance</th></tr></thead><tbody>{records.map((record)=>{
    const {match}=record;
    const summary=summaries.get(match.key)!;
    const matchFlags=[
      ...(summary.prediction?[{label:summary.prediction.label,tone:summary.prediction.tone}]:[]),
      ...(summary.modelUpset?[{label:"Model Upset",tone:"bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"}]:[]),
      ...(summary.anomalousScore?[{label:"Anomalous Score",tone:"bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"}]:[]),
 

    ];
    return <tr key={match.key} className="border-b border-slate-100 dark:border-slate-800">
      <th className="py-2 pr-2 text-left align-middle">
        <a href={"https://www.thebluealliance.com/match/"+match.key} target="_blank" rel="noreferrer" className="text-[11px] font-semibold text-slate-900 hover:text-slate-600 hover:underline dark:text-slate-100 dark:hover:text-white">{matchShortName(match,data.event.playoff_type)}</a>
        {matchFlags.length?<div className="mt-1 flex flex-wrap gap-1">{matchFlags.map((flag,index)=><span key={flag.label+"-"+index} title={flag.label} className={"inline-flex rounded-full px-1.5 py-1 text-[9px] font-bold leading-3 "+flag.tone}>{flag.label}</span>)}</div>:null}
      </th>
      {allianceCell(record,"red")}{allianceCell(record,"blue")}
    </tr>;
  })}</tbody></table></div>;
}

function PlayoffAnalysisPanel({data}:{data:EventAnalyticsResponse}) {
  const matches=data.matches.filter(({match})=>match.comp_level!=="qm").sort((a,b)=>{const order=["ef","qf","sf","f"];return order.indexOf(a.match.comp_level)-order.indexOf(b.match.comp_level)||a.match.set_number-b.match.set_number||a.match.match_number-b.match.match_number;});
  const completed=matches.flatMap((record)=>{
    const {match,statbotics}=record;
    const redScore=match.alliances.red.score;
    const blueScore=match.alliances.blue.score;
    if(redScore<0||blueScore<0)return [];
    const winner=match.winning_alliance==="red"||match.winning_alliance==="blue"?match.winning_alliance:redScore===blueScore?null:redScore>blueScore?"red":"blue";
    const probability=typeof statbotics?.pred?.red_win_prob==="number"?statbotics.pred.red_win_prob:null;
    const redResult=data.allianceResults.find((item)=>item.matchKey===match.key&&item.color==="red");
    const blueResult=data.allianceResults.find((item)=>item.matchKey===match.key&&item.color==="blue");
    return [{record,match,winner,probability,redScore,blueScore,margin:Math.abs(redScore-blueScore),redResult,blueResult}];
  });
  const residualMagnitudes=completed.flatMap((item)=>[item.redResult?.residual,item.blueResult?.residual].filter((value):value is number=>typeof value==="number"&&Number.isFinite(value)).map(Math.abs)).sort((a,b)=>a-b);
  const quantile=(values:number[],p:number)=>values.length?values[Math.min(values.length-1,Math.ceil(values.length*p)-1)]:null;
  const unexpectedThreshold=residualMagnitudes.length>=10?quantile(residualMagnitudes,0.9):null;
  const upsets=completed.flatMap((item)=>{
    const {winner,probability}=item;
    if(!winner||probability===null)return [];
    const predictedWinner=probability>=0.5?"red":"blue";
    const favoriteProbability=predictedWinner==="red"?probability:1-probability;
    return winner!==predictedWinner&&favoriteProbability>=0.6?[{...item,favorite:predictedWinner,favoriteProbability}]:[];
  }).sort((a,b)=>b.favoriteProbability-a.favoriteProbability);
  const unexpected=unexpectedThreshold===null?[]:completed.filter((item)=>[item.redResult?.residual,item.blueResult?.residual].some((value)=>typeof value==="number"&&Math.abs(value)>=unexpectedThreshold)).sort((a,b)=>Math.max(Math.abs(b.redResult?.residual??0),Math.abs(b.blueResult?.residual??0))-Math.max(Math.abs(a.redResult?.residual??0),Math.abs(a.blueResult?.residual??0)));
  const closest=[...completed].sort((a,b)=>a.margin-b.margin).slice(0,5);
  return <div className="space-y-4">
    <Panel title="Playoff upsets" description="Completed elimination matches where the pre-match favorite had at least a 60% win probability but lost.">
      {upsets.length?<div className="w-full min-w-0"><MatchAnalysisTable data={data} records={upsets.map((item)=>item.record)} playoff/></div>:<p className="text-sm text-slate-500">No completed playoff matches meet the upset definition yet. Matches without a winner prediction are excluded.</p>}
    </Panel>
    <Panel title="Unexpected results" description={unexpectedThreshold===null?"Alliance score residuals need a larger completed-match sample before unusual results can be highlighted.":"Matches where at least one alliance's absolute score residual falls in the top 10% of playoff alliance results in this event."}>
      {unexpected.length?<div className="w-full min-w-0"><MatchAnalysisTable data={data} records={unexpected.map((item)=>item.record)} playoff/></div>:<p className="text-sm text-slate-500">{unexpectedThreshold===null?"Not enough scored alliance predictions are available to establish an event-relative threshold.":"No completed playoff match currently falls in the unusual-score range."}</p>}
    </Panel>
    <Panel title="Closest matches" description="The five smallest final score margins among completed elimination matches.">
      {closest.length?<div className="w-full min-w-0"><MatchAnalysisTable data={data} records={closest.map((item)=>item.record)} playoff/></div>:<p className="text-sm text-slate-500">Completed playoff scores are not available yet.</p>}
    </Panel>
    <Panel title="Playoff match explorer" description="Every elimination match record processed so far, with alliance-level score comparisons and the existing match review markers.">
      <MatchAnalysisTable data={data} records={matches} playoff/>
      <p className="mt-3 text-xs text-slate-500">Anomalous Score marks alliance residuals more than two event standard deviations from zero. Unexpected Results above uses a separate event-relative top-decile threshold. Match-level outcomes describe the alliance, not an individual robot.</p>
    </Panel>
  </div>;
}

function PlayoffAllianceAnalysisPanel({data}:{data:EventAnalyticsResponse}) {
  const playoff=data.playoffAnalysis;
  const teamsByKey=new Map(data.teams.map((team)=>[team.teamKey,team]));
  if(!playoff||!playoff.alliances.length)return <Panel title="Playoff alliance investigation" description="Compare official playoff alliances across their elimination performance."><p className="text-sm text-slate-500">Playoff alliance data will appear when TBA publishes the alliance selections and completed match results.</p></Panel>;

  const eligible=playoff.alliances.filter((alliance)=>alliance.scoredMatchCount>0&&alliance.meanResidual!==null);
  const fieldSampleSize=eligible.reduce((sum,alliance)=>sum+alliance.scoredMatchCount,0);
  const fieldMean=fieldSampleSize?eligible.reduce((sum,alliance)=>sum+(alliance.meanResidual??0)*alliance.scoredMatchCount,0)/fieldSampleSize:null;
  const fieldVariance=fieldMean===null||fieldSampleSize<2?null:eligible.reduce((sum,alliance)=>sum+(alliance.scoredMatchCount-1)*(alliance.residualStandardDeviation??0)**2+alliance.scoredMatchCount*((alliance.meanResidual??0)-fieldMean)**2,0)/(fieldSampleSize-1);
  const fieldSpread=fieldVariance===null?null:Math.sqrt(fieldVariance);

  const predictionAssessment=(alliance:typeof playoff.alliances[number])=>{
    if(alliance.scoredMatchCount<2||alliance.meanResidual===null||alliance.residualStandardDeviation===null)return {label:"Insufficient sample",tone:"bg-slate-100 text-slate-600",lower:null as number|null,upper:null as number|null};
    const df=alliance.scoredMatchCount-1;
    const tCritical=[0,12.706,4.303,3.182,2.776,2.571,2.447,2.365,2.306,2.262,2.228,2.201,2.179,2.160,2.145,2.131,2.120,2.110,2.101,2.093,2.086,2.080,2.074,2.069,2.064,2.060,2.056,2.052,2.048,2.045,2.042];
    const margin=(df<=30?tCritical[df]??1.96:1.96)*alliance.residualStandardDeviation/Math.sqrt(alliance.scoredMatchCount);
    const lower=alliance.meanResidual-margin;
    const upper=alliance.meanResidual+margin;
    if(lower>0)return {label:"Above prediction",tone:"bg-emerald-100 text-emerald-800",lower,upper};
    if(upper<0)return {label:"Below prediction",tone:"bg-rose-100 text-rose-800",lower,upper};
    return {label:"Inconclusive",tone:"bg-slate-100 text-slate-700",lower,upper};
  };
  const fieldComparison=(alliance:typeof playoff.alliances[number])=>{
    if(alliance.meanResidual===null)return null;
    const otherCount=fieldSampleSize-alliance.scoredMatchCount;
    if(otherCount<=0)return null;
    const otherMean=eligible.filter((item)=>item!==alliance).reduce((sum,item)=>sum+(item.meanResidual??0)*item.scoredMatchCount,0)/otherCount;
    return alliance.meanResidual-otherMean;
  };
  const signed=(value:number|null)=>value===null?"—":(value>0?"+":"")+fmt(value)+" pts";

  return <Panel title="Playoff alliance performance" description="Compare each alliance with the rest of the playoff field, alongside its performance against Statbotics predictions.">
    <div className="grid gap-3 sm:grid-cols-2">
      <QualityMetric label="Playoff field bias" value={signed(fieldMean)} detail={fieldSampleSize+" alliance scores · negative means predictions tended high"}/>
      <QualityMetric label="Residual spread (sample SD)" value={fieldSpread===null?"—":fmt(fieldSpread)+" pts"} detail="Sample standard deviation across playoff alliance scores"/>
    </div>
    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-sm font-semibold text-slate-900">Field-relative comparison</p>
      <p className="mt-1 text-xs leading-5 text-slate-600">The primary comparison is each alliance's mean residual against the match-count-weighted average residual of all other playoff alliances. Positive values indicate better-than-field results; negative values indicate worse-than-field results. The playoff field's overall bias is shown above so model-wide overprediction is not mistaken for alliance-specific underperformance.</p>
    </div>
    <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200"><table className="w-full table-auto text-xs"><thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-3">Alliance</th><th className="px-3 py-3">Teams</th><th className="px-3 py-3">Record</th><th className="px-3 py-3">Vs. rest of field <span className="ml-1 text-blue-600">· primary</span></th><th className="px-3 py-3">Mean residual</th><th className="px-3 py-3">95% CI for mean residual</th><th className="px-3 py-3">Sample residual SD</th><th className="px-3 py-3">Matches</th><th className="px-3 py-3">Prediction assessment</th></tr></thead><tbody>{playoff.alliances.map((alliance,index)=>{const prediction=predictionAssessment(alliance);const relative=fieldComparison(alliance);return <tr key={alliance.name??alliance.teamKeys.join("|")+index} className="border-t border-slate-100 align-middle"><th className="px-3 py-3 text-left font-semibold text-slate-900">{alliance.name??`Alliance ${index+1}`}</th><td className="px-3 py-3"><div className="flex flex-wrap gap-x-2 gap-y-1">{alliance.teamKeys.map((key)=><a key={key} href={`/team/${teamsByKey.get(key)?.teamNumber??formatTeamNumber(key)}`} className="whitespace-nowrap font-semibold tabular-nums text-blue-700 hover:underline">{teamsByKey.has(key)?teamsByKey.get(key)!.teamNumber:formatTeamNumber(key)}</a>)}</div></td><td className="px-3 py-3 tabular-nums">{alliance.wins}–{alliance.losses}–{alliance.ties}</td><td className={"px-3 py-3 text-base font-black tabular-nums "+(relative===null?"text-slate-500 dark:text-slate-400":relative>0?"text-emerald-700 dark:text-emerald-300":relative<0?"text-rose-700 dark:text-rose-300":"text-slate-700 dark:text-slate-200")}>{signed(relative)}</td><td className={"px-3 py-3 font-semibold tabular-nums "+(alliance.meanResidual===null?"text-slate-400":alliance.meanResidual>0?"text-emerald-700":alliance.meanResidual<0?"text-rose-700":"text-slate-700")}>{signed(alliance.meanResidual)}</td><td className="px-3 py-3 tabular-nums text-slate-600">{prediction.lower===null||prediction.upper===null?"—":fmt(prediction.lower)+" to "+fmt(prediction.upper)+" pts"}</td><td className="px-3 py-3 tabular-nums">{fmt(alliance.residualStandardDeviation)} pts</td><td className="px-3 py-3 tabular-nums">{alliance.scoredMatchCount}</td><td className="px-3 py-3"><span className={"inline-flex rounded-full px-2 py-1 text-[10px] font-bold "+prediction.tone}>{prediction.label}</span></td></tr>;})}</tbody></table></div>
    <p className="mt-3 text-xs leading-5 text-slate-500">“Vs. rest of field” is a descriptive difference from the match-count-weighted mean of the other alliances; it is not a significance test. A match-level paired comparison would be needed for a defensible confidence interval because the two alliance scores in a match are related. The 95% confidence interval estimates each alliance mean residual against zero and requires at least two scored matches; “Inconclusive” means the interval includes zero. Residual spread uses sample standard deviation (n−1). Official alliance names are used when supplied by TBA.</p>
  </Panel>;
}

function EpaShareBar({share,alliance}:{share:number|null;alliance:"red"|"blue"}) {
  if(share===null)return <span className="text-slate-400">—</span>;
  const width=Math.max(0,Math.min(100,share));
  return <div className="min-w-[76px]" title="Selected team's pre-match EPA divided by the combined pre-match EPA of its alliance">
    <span className="block text-right text-[11px] font-semibold tabular-nums text-slate-700">{fmt(share)}%</span>
    <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-100">
      <span className={`block h-full rounded-full ${alliance==="red"?"bg-rose-500":"bg-blue-500"}`} style={{width:`${width}%`}}/>
    </span>
  </div>;
}

function TeamCurrentEventOutlook({analysis,records,teamNumber,eventKey,timezone}:{analysis:TeamMatchAnalysis;records:EventAnalyticsResponse["matches"];teamNumber:number;eventKey:string;timezone:string|null}) {
  const currentMatches=analysis.matches.filter((match)=>match.event.key===eventKey);
  const ordered=[...currentMatches].sort((a,b)=>a.matchKey.localeCompare(b.matchKey,undefined,{numeric:true}));
  const scored=ordered.filter((match)=>match.actual!==null&&match.opponentActual!==null);
  const completed=scored.filter((match)=>match.won!==null);
  const eventRecord=scored.reduce((record,match)=>{
    if(match.won===true)record.wins++;
    else if(match.won===false)record.losses++;
    else {
      const source=records.find((item)=>item.match.key===match.matchKey)?.match;
      if(source?.winning_alliance===""&&match.actual===match.opponentActual)record.ties++;
    }
    return record;
  },{wins:0,losses:0,ties:0});
  const wins=completed.filter((match)=>match.won===true).sort((a,b)=>((b.actual??0)-(b.opponentActual??0))-((a.actual??0)-(a.opponentActual??0)));
  const biggestWin=wins[0]??null;
  const upsetLoss=completed.filter((match)=>match.won===false&&match.teamWinProbability!==null&&match.teamWinProbability>=0.65).sort((a,b)=>(b.teamWinProbability??0)-(a.teamWinProbability??0))[0]??null;
  const unexpectedWin=completed.filter((match)=>match.won===true&&match.teamWinProbability!==null&&match.teamWinProbability<=0.35).sort((a,b)=>(a.teamWinProbability??1)-(b.teamWinProbability??1))[0]??null;
  let streakCount=0;
  let streakResult:boolean|null=null;
  for (const match of [...scored].reverse()) {
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
  const past=[...scored].reverse().slice(0,8);
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
        <div className="min-w-0 text-sm"><p className={`font-bold ${teamAllianceClass(match.alliance === "red" ? "red" : "blue")}`}>{allianceTeamNumbers(teamNumber,match.partners).join(" · ")}</p><p className={`mt-0.5 text-xs font-semibold ${opponentAllianceClass(match.alliance)}`}>vs {match.opponents.join(" · ")||"opponents"}</p></div>
        <p className="shrink-0 text-xl font-black tabular-nums"><span className={teamAllianceClass(match.alliance === "red" ? "red" : "blue")}>{fmt(match.actual,0)}</span><span className="px-1 text-slate-400">–</span><span className={opponentAllianceClass(match.alliance)}>{fmt(match.opponentActual,0)}</span></p>
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
      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] font-semibold text-slate-500">Event record</p><p className="mt-1 text-xl font-black tabular-nums text-slate-900">{eventRecord.wins}–{eventRecord.losses}–{eventRecord.ties}</p><p className="text-[11px] text-slate-500">{scored.length} scored matches</p></div>
      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] font-semibold text-slate-500">Recent form</p><p className="mt-1 text-xl font-black tabular-nums text-slate-900">{streakLabel}</p><p className="text-[11px] text-slate-500">Current consecutive result streak</p></div>
      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] font-semibold text-slate-500">Remaining schedule</p><p className="mt-1 text-xl font-black tabular-nums text-slate-900">{upcoming.length}</p><p className="text-[11px] text-slate-500">Upcoming matches with model predictions</p></div>
    </div>
    <div className="mt-4 border-t border-slate-100 pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold text-slate-800">Standout matches at this event</h4><p className="text-xs text-slate-500">Largest win and strongest prediction upsets in this event's completed matches</p></div>
      {highlights.length?<div className="mt-3 grid gap-3 lg:grid-cols-2">{highlights}</div>:<p className="mt-2 text-sm text-slate-500">No completed match with a standout margin or strong prediction upset is available at this event yet.</p>}
    </div>
    <div className="mt-4 grid gap-4 xl:grid-cols-2">
      <div className="min-w-0"><h4 className="text-sm font-semibold text-slate-800">Recent matches</h4>
        {past.length?<div className="mt-2 overflow-x-auto"><table className="w-full min-w-[510px] text-xs"><thead className="text-left text-[10px] uppercase tracking-wide text-slate-400"><tr><th className="py-2">Match</th><th>Alliance teams</th><th>Alliance score<br/>predicted → actual</th><th>Auto</th><th>Teleop</th><th>Endgame EPA Δ</th><th>EPA share*</th></tr></thead><tbody>{past.map((match)=><tr key={match.matchKey} className="border-t border-slate-100"><th className="py-2 text-left"><a className="font-semibold text-slate-800 hover:underline" href={`https://www.thebluealliance.com/match/${match.matchKey}`} target="_blank" rel="noreferrer">{match.matchLabel}</a><span className={`block text-[10px] font-semibold ${match.alliance==="red"?"text-rose-700":"text-blue-700"}`}>{match.alliance==="red"?"Red":"Blue"} alliance · {match.won===null?(match.actual===match.opponentActual?"Tie":"—"):match.won?"Win":"Loss"}</span></th><td><div className="min-w-[105px] space-y-1"><p className={`font-semibold ${teamAllianceClass(match.alliance === "red" ? "red" : "blue")}`}>{allianceTeamNumbers(teamNumber,match.partners).join(" · ")}</p><p className={`font-semibold ${opponentAllianceClass(match.alliance)}`}>{match.opponents.join(" · ")}</p></div></td><td className="whitespace-nowrap tabular-nums"><span className={teamAllianceClass(match.alliance === "red" ? "red" : "blue")}>{fmt(match.predicted)}</span><span className="px-1 text-slate-400">→</span><span className={teamAllianceClass(match.alliance === "red" ? "red" : "blue")}>{fmt(match.actual)}</span></td>{(["auto","teleop"] as const).map((component)=>{const estimate=match.alliancePreComponents[`${component}_epa`];const actual=match.actualComponents[component];return <td key={component} className={`whitespace-nowrap tabular-nums ${teamAllianceClass(match.alliance === "red" ? "red" : "blue")}`}>{fmt(estimate)} → {fmt(actual)}</td>;})}<td className="whitespace-nowrap tabular-nums">{typeof match.preComponents.endgame_epa==="number"&&typeof match.postComponents.endgame_epa==="number"?<span className={match.postComponents.endgame_epa-match.preComponents.endgame_epa>=0?"text-emerald-700":"text-rose-700"}>{match.preComponents.endgame_epa.toFixed(1)} → {match.postComponents.endgame_epa.toFixed(1)} ({match.postComponents.endgame_epa-match.preComponents.endgame_epa>0?"+":""}{(match.postComponents.endgame_epa-match.preComponents.endgame_epa).toFixed(1)})</span>:"—"}</td><td><EpaShareBar share={estimatedShare(match)} alliance={match.alliance}/></td></tr>)}</tbody></table></div>:<p className="mt-2 text-sm text-slate-500">No completed matches for this team are available at this event yet.</p>}
        <p className="mt-2 text-[10px] leading-5 text-slate-500">Predicted and actual scores are alliance totals. Auto and teleop compare alliance EPA estimates with TBA's recorded component scores. Endgame shows this team's Statbotics endgame EPA before → after the match and the change; it is an inferred model update, not measured match points. EPA share is the team's pre-match EPA divided by its alliance's combined pre-match EPA.</p>
      </div>
      <div className="min-w-0"><h4 className="text-sm font-semibold text-slate-800">Upcoming matches</h4>
        {upcoming.length?<div className="mt-2 space-y-2">{upcoming.map((match)=>{
          const close=match.teamWinProbability!==null&&Math.abs(match.teamWinProbability-0.5)<=0.15;
          const opposing: "red" | "blue" = match.alliance === "red" ? "blue" : "red";
          return <a key={match.key} href={`https://www.thebluealliance.com/match/${match.key}`} target="_blank" rel="noreferrer" className="block rounded-lg border border-slate-200 p-3 hover:border-slate-400">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold text-slate-900">{match.label}</span><span className="text-[10px] text-slate-500">{formatEventTime(match.time)} · event time</span></div>
            <div className="mt-2 space-y-1 text-xs"><p className="font-semibold text-rose-700">{match.redTeams.join(" · ")}</p><p className="font-semibold text-blue-700">{match.blueTeams.join(" · ")}</p></div><div className="mt-2 flex items-center justify-between gap-3 text-sm"><span className={`font-bold tabular-nums ${teamAllianceClass(match.alliance === "red" ? "red" : "blue")}`}>{match.alliance==="red"?"RED":"BLUE"} · {match.alliance==="red"?fmt(match.redScore):fmt(match.blueScore)}</span><span className="text-slate-400">vs</span><span className={`font-bold tabular-nums ${teamAllianceClass(opposing)}`}>{opposing.toUpperCase()} · {match.alliance==="red"?fmt(match.blueScore):fmt(match.redScore)}</span></div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500"><span>Team alliance win probability: {match.teamWinProbability===null?"—":(match.teamWinProbability*100).toFixed(0)+"%"}</span><span className="font-semibold text-slate-600">{predictionClassification(match.alliance==="red"?match.teamWinProbability===null?null:match.teamWinProbability:match.teamWinProbability===null?null:1-match.teamWinProbability)??"Prediction unavailable"}</span><span className={close?"font-semibold text-amber-700":"text-slate-500"}>{close?"Closest projected matchup":"Model projection"}</span></div>
          </a>;
        })}</div>:<p className="mt-2 text-sm text-slate-500">No upcoming match with a published Statbotics prediction is available at this event.</p>}
        <p className="mt-2 text-[10px] leading-5 text-slate-500">Projected scores and win probability are alliance-level Statbotics predictions. A close matchup means the model sees a relatively even contest; it does not establish tournament or ranking-point importance.</p>
      </div>
    </div>

  </section>;
}

function TeamSnapshot({teams,selectedTeam,onSelect,team,insight,data}:{teams:TeamAnalyticsRow[];selectedTeam:string;onSelect:(value:string)=>void;team:TeamAnalyticsRow|undefined;insight:TeamInsight|null;data:EventAnalyticsResponse}) {
  const [selectorOpen,setSelectorOpen]=useState(false);
  const [teamSearch,setTeamSearch]=useState("");
  const selectorRef=useRef<HTMLDivElement>(null);
  const selectedOption=teams.find((item)=>String(item.teamNumber)===selectedTeam);
  const filteredTeams=teams.filter((item)=>(String(item.teamNumber)+" "+item.name).toLowerCase().includes(teamSearch.trim().toLowerCase()));
  useEffect(()=>{
    if(!selectorOpen)return;
    const closeOnOutsidePointer=(event:PointerEvent)=>{if(event.target instanceof Node&&!selectorRef.current?.contains(event.target))setSelectorOpen(false);};
    document.addEventListener("pointerdown",closeOnOutsidePointer);
    return ()=>document.removeEventListener("pointerdown",closeOnOutsidePointer);
  },[selectorOpen]);

  const comparison=insight?.seasonComparison??null;
  const currentComponents=[
    {key:"auto",label:"Auto",value:comparison?.components.auto?.current??team?.autoEpa??null},
    {key:"teleop",label:"Teleop",value:comparison?.components.teleop?.current??team?.teleopEpa??null},
    {key:"endgame",label:"Endgame",value:comparison?.components.endgame?.current??team?.endgameEpa??null},
  ];
  const priorComponents=[
    {key:"auto",label:"Auto",value:comparison?.components.auto?.prior??null},
    {key:"teleop",label:"Teleop",value:comparison?.components.teleop?.prior??null},
    {key:"endgame",label:"Endgame",value:comparison?.components.endgame?.prior??null},
  ];
  const componentChanges=[
    {key:"auto",label:"Auto",value:comparison?.components.auto?.change??null},
    {key:"teleop",label:"Teleop",value:comparison?.components.teleop?.change??null},
    {key:"endgame",label:"Endgame",value:comparison?.components.endgame?.change??null},
  ];
  const currentTotal=currentComponents.reduce((sum,item)=>sum+Math.max(0,item.value??0),0);
  const playoffAlliance=data.playoffAnalysis?.alliances.find((alliance)=>alliance.teamKeys.includes(team?.teamKey??""));
  const metric=(value:number|null|undefined)=>value===null||value===undefined?"—":fmt(value);
  const componentList=(items:typeof currentComponents)=> <div className="mt-2 grid grid-cols-3 gap-2">{items.map((item)=><div key={item.key} className="min-w-0"><p className="text-[10px] font-semibold uppercase text-slate-500">{item.label}</p><p className="mt-0.5 text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100">{metric(item.value)}</p></div>)}</div>;

  return <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-950 sm:p-5">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-xs font-bold uppercase tracking-wide text-blue-700">Team investigation</p><h2 className="mt-1 text-lg font-bold text-slate-900 dark:text-slate-100">Team overview</h2></div>
      <div ref={selectorRef} className={"relative w-full max-w-sm text-xs font-semibold text-slate-600 dark:text-slate-300 "+(selectorOpen?"z-[60]":"")}>
        <label className="block">Select team</label>
        <button type="button" aria-haspopup="listbox" aria-expanded={selectorOpen} onClick={()=>{setSelectorOpen((open)=>!open);setTeamSearch("");}} className="mt-1 flex w-full items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm font-normal text-slate-800 shadow-sm hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800">
          <span className="min-w-0 truncate">{selectedOption?String(selectedOption.teamNumber)+" · "+selectedOption.name:"Choose a team…"}</span><span aria-hidden="true" className="shrink-0 text-slate-400">{selectorOpen?"▴":"▾"}</span>
        </button>
        {selectorOpen?<div className="absolute right-0 top-full z-[70] mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
          <div className="border-b border-slate-100 p-2 dark:border-slate-700"><input autoFocus value={teamSearch} onChange={(event)=>setTeamSearch(event.target.value)} placeholder="Search teams…" aria-label="Search teams" className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"/></div>
          <div role="listbox" aria-label="Teams" className="max-h-64 overflow-y-auto overscroll-contain p-1">
            {filteredTeams.length?filteredTeams.map((item)=><button key={item.teamKey} type="button" role="option" aria-selected={selectedTeam===String(item.teamNumber)} onClick={()=>{onSelect(String(item.teamNumber));setSelectorOpen(false);setTeamSearch("");}} className={"block w-full rounded-md px-3 py-2 text-left text-sm font-normal "+(selectedTeam===String(item.teamNumber)?"bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200":"text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800")}><span className="font-semibold tabular-nums">{item.teamNumber}</span><span className="text-slate-500"> · {item.name}</span></button>):<p className="px-3 py-4 text-center text-sm font-normal text-slate-500">No teams match that search.</p>}
          </div>
        </div>:null}
      </div>
    </div>
    {!selectedTeam?<p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-600 dark:bg-slate-900 dark:text-slate-300">Choose a team to see its event standing, season development, comparable-alliance context, and matches worth reviewing.</p>:!team||!insight?<p className="mt-4 text-sm text-slate-500">The team overview is still being assembled from the available event data.</p>:<>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-100 pt-4 dark:border-slate-800">
        <div className="min-w-0 flex-1"><h3 className="text-lg font-black text-slate-950 dark:text-slate-50">{team.teamNumber} · {team.name}</h3><a href={"https://www.thebluealliance.com/team/"+team.teamNumber} target="_blank" rel="noreferrer" className="text-[11px] font-semibold text-blue-700 hover:underline">Team history on TBA ↗</a></div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <div><p className="text-[10px] font-semibold uppercase text-slate-500">Qual Rank</p><p className="font-bold tabular-nums text-slate-900 dark:text-slate-100">{insight.metrics.rank===null?"—":"#"+insight.metrics.rank}</p></div>
          <div><p className="text-[10px] font-semibold uppercase text-slate-500">Qual Record</p><p className="font-bold tabular-nums text-slate-900 dark:text-slate-100">{insight.metrics.wins===null||insight.metrics.losses===null||insight.metrics.ties===null?"—":insight.metrics.wins+"–"+insight.metrics.losses+"–"+insight.metrics.ties}</p></div>
          <div><p className="text-[10px] font-semibold uppercase text-slate-500">Playoff Alliance</p><p className="font-bold text-slate-900 dark:text-slate-100">{playoffAlliance?.name??"—"}</p></div>
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[0.85fr_1.15fr]">
        <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Traditional team ratings</p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {([{label:"OPR",value:team.opr},{label:"DPR",value:team.dpr},{label:"CCWM",value:team.ccwm}] as const).map((item)=><div key={item.label}><p className="text-[10px] font-semibold text-slate-500">{item.label}</p><p className="text-base font-black tabular-nums text-slate-900 dark:text-slate-100">{metric(item.value)}</p></div>)}
          </div>
          <p className="mt-2 text-[10px] leading-4 text-slate-500">Separate statistical estimates; not directly comparable measurements.</p>
        </div>
        <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Current-event comparable alliances</p>
          <p className="mt-2 text-sm leading-5 text-slate-700 dark:text-slate-200">{insight.peerPerformance.interpretation==="insufficient-sample"?"Not enough qualification results to compare this team's alliances with the event field.":<>Team alliances averaged <strong className="tabular-nums">{metric(insight.peerPerformance.teamMeanResidual)} pts</strong> residual versus <strong className="tabular-nums">{metric(insight.peerPerformance.peerMeanResidual)} pts</strong> for {insight.peerPerformance.peerAllianceCount} other strength-matched alliances. Difference: <strong className="tabular-nums">{insight.peerPerformance.difference===null?"—":(insight.peerPerformance.difference>0?"+":"")+fmt(insight.peerPerformance.difference)+" pts"}</strong> across {insight.peerPerformance.teamMatches} team matches.</>}</p>
          <p className="mt-1 text-[10px] leading-4 text-slate-500">Qualification alliances matched within ±20% of combined pre-match EPA; alliance-level results cannot isolate an individual robot.</p>
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Last Event</p>
          <p className="mt-1 truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{comparison?.priorEvent.name??"Prior event unavailable"}</p>
          <p className="mt-2 text-xl font-black tabular-nums text-slate-900 dark:text-slate-100">{comparison?fmt(comparison.priorEPA)+" EPA":"—"}</p>
          <p className="mt-0.5 text-base font-bold tabular-nums text-slate-700 dark:text-slate-200">{comparison?ordinal(comparison.priorEpaRank)+" of "+comparison.priorEpaCohortSize:"—"}</p>
          {componentList(priorComponents)}
        </div>
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">EPA Change</p>
          <p className={"mt-1 text-2xl font-black tabular-nums "+(comparison===null?"text-slate-400":comparison.change>=0?"text-emerald-700 dark:text-emerald-400":"text-rose-700 dark:text-rose-400")}>{comparison?(comparison.change>0?"+":"")+fmt(comparison.change)+" EPA":"—"}</p>
          <p className="mt-0.5 text-base font-bold tabular-nums text-slate-700 dark:text-slate-200">{comparison?ordinal(comparison.cohortRank)+" of "+comparison.cohortSize:"—"}</p>
          <div className="mt-2 grid grid-cols-3 gap-2 border-t border-slate-100 pt-2 dark:border-slate-700">{componentChanges.map((item)=><div key={item.key} className="min-w-0"><p className="text-[10px] font-semibold uppercase text-slate-500">{item.label}</p><p className={"mt-0.5 text-sm font-bold tabular-nums "+(item.value===null?"text-slate-400":item.value>0?"text-emerald-700 dark:text-emerald-400":item.value<0?"text-rose-700 dark:text-rose-400":"text-slate-700 dark:text-slate-200")}>{item.value===null?"—":(item.value>0?"+":"")+fmt(item.value)}</p></div>)}</div>
        </div>
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Current Event</p>
          <p className="mt-1 truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{data.event.name}</p>
          <p className="mt-2 text-xl font-black tabular-nums text-slate-900 dark:text-slate-100">{metric(comparison?.currentEPA??team.epa)} EPA</p>
          <p className="mt-0.5 text-base font-bold tabular-nums text-slate-700 dark:text-slate-200">{comparison?ordinal(comparison.currentEpaRank)+" of "+comparison.currentEpaCohortSize:"—"}</p>
          {componentList(currentComponents)}
        </div>
      </div>

      <div className="mt-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="text-xs font-bold uppercase tracking-wide text-slate-500">Current-event component EPA breakdown</p><p className="text-[10px] text-slate-500">Model estimates · not measured scoring</p></div>
        <div className="mt-2 flex h-3 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700" aria-label="Current event EPA component proportions">
          {currentComponents.map((item,index)=><span key={item.key} className={index===0?"bg-amber-400":index===1?"bg-blue-500":"bg-emerald-500"} style={{width:currentTotal>0&&item.value!==null?Math.max(0,item.value??0)/currentTotal*100+"%":"0%"}} title={item.label+": "+metric(item.value)}/>)}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">{currentComponents.map((item,index)=><span key={item.key} className="inline-flex items-center gap-1.5"><span className={"h-2 w-2 rounded-sm "+(index===0?"bg-amber-400":index===1?"bg-blue-500":"bg-emerald-500")}/>{item.label} {metric(item.value)}</span>)}</div>
      </div>
      <p className="mt-2 text-[10px] leading-4 text-slate-500">Each team is compared with its own most recent prior official event. EPA and component changes are model estimate updates, not measured scoring changes. Traditional ratings, comparable-alliance results, and EPA describe different aspects of performance.</p>
    </>}
  </section>;
}


type TeamAnalysisTab = "qualification" | "playoffs" | "season" | "review";

function TeamAnalysisTabs({analysis,records,eventKey,timezone,name}:{analysis:TeamMatchAnalysis;records:EventAnalyticsResponse["matches"];eventKey:string;timezone:string|null;name:string}) {
  const [activeTab,setActiveTab]=useState<TeamAnalysisTab>("qualification");
  const tabs:{id:TeamAnalysisTab;label:string}[]=[
    {id:"qualification",label:"Qualification Analysis"},
    {id:"playoffs",label:"Playoff Analysis"},
    {id:"season",label:"Season Analysis"},
    {id:"review",label:"Team Match Review"},
  ];
  return <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-950">
    <div className="border-b border-slate-200 px-4 pt-4 dark:border-slate-700 sm:px-5">
      <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Team analysis</h3>
      <p className="mt-1 text-xs text-slate-500">Explore this team's event performance, season development, and matches worth a closer look.</p>
      <div role="tablist" aria-label="Team analysis sections" className="no-scrollbar mt-3 -mb-px flex gap-1 overflow-x-auto">
        {tabs.map((tab)=><button key={tab.id} type="button" role="tab" id={`team-analysis-tab-${tab.id}`} aria-controls={`team-analysis-panel-${tab.id}`} aria-selected={activeTab===tab.id} onClick={()=>setActiveTab(tab.id)} className={"shrink-0 border-b-2 px-3 py-3 text-sm font-semibold transition-colors "+(activeTab===tab.id?"border-blue-600 text-blue-700 dark:text-blue-300":"border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200")}>{tab.label}</button>)}
      </div>
    </div>
    <div role="tabpanel" id={`team-analysis-panel-${activeTab}`} aria-labelledby={`team-analysis-tab-${activeTab}`} className="space-y-4 p-4 sm:p-5">
      {activeTab==="qualification"?<>
        <TeamCurrentEventOutlook analysis={analysis} records={records} teamNumber={analysis.team} eventKey={eventKey} timezone={timezone}/>
        <PhasePerformancePanel analysis={analysis} phase="qualification"/>
      </>:null}
      {activeTab==="playoffs"?<>
        <PhasePerformancePanel analysis={analysis} phase="elimination"/>
        <EliminationShiftPanel analysis={analysis}/>
      </>:null}
      {activeTab==="season"?<MatchAnalysisSummary analysis={analysis} name={name}/>:null}
      {activeTab==="review"?<>
        <TeamRiskPanel analysis={analysis}/>
        <details className="rounded-lg border border-slate-200 dark:border-slate-700">
          <summary className="cursor-pointer px-3 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200">Match-by-match EPA and score evidence</summary>
          <div className="p-3"><TeamMatchEpaLedger analysis={analysis} name={name}/></div>
        </details>
      </>:null}
    </div>
  </section>;
}

function EliminationShiftPanel({analysis}:{analysis:TeamMatchAnalysis}) {
  const result = analysis.eliminationShift;
  const recurring = result.interpretation === "recurring-negative-shift";
  const label = result.interpretation === "no-elimination-matches" ? "No elimination matches played"
    : result.interpretation === "single-event-shift" ? "Single-event comparison"
    : recurring ? "Recurring decline signal"
    : result.interpretation === "insufficient-history" ? "More match data needed" : "No established recurring direction";
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
        <p className="mt-1 text-xs text-slate-500">One-sided sign test across {result.directionalEventCount} non-tied events; smaller means stronger evidence of a recurring decline</p>
      </div>
    </div>

    {result.events.length ? <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-sm font-bold text-slate-900">Event-by-event comparison</h5>
        <p className="text-xs text-slate-500">{result.events.length} eligible events · {positiveCount} increased · {negativeCount} decreased · {unchangedCount} unchanged</p>
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
      <p className="mt-1">The recurrence test uses the direction of every non-tied eligible event shift, regardless of qualification baseline or shift magnitude. The p-value tests whether declines recur more often than increases; it does not measure the size or certainty of any one event shift. Shift uncertainty is shown separately. p-values are not proof of cause. Partner and opponent strength are not adjusted for, and alliance results cannot isolate one robot's contribution. Treat this as exploratory evidence, not a team label.</p>
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
        <p className="mt-1 max-w-3xl text-xs text-slate-600">Did the team's alliances score more or fewer points than expected compared with the opposing alliances they actually faced?</p>
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
            <div className="min-w-0"><p className="text-sm font-semibold text-slate-800">{item.event.name}</p><p className="text-xs text-slate-500">{item.teamMatches} team matches · Team residual {fmt(item.teamMeanResidual)} · Opposing-alliance residual {fmt(item.baselineMeanResidual)} (n={item.baselineAllianceSamples})</p></div>
            <span className={`shrink-0 text-sm font-bold tabular-nums ${gap>=0?"text-emerald-700":"text-rose-700"}`}>{gap>0?"+":""}{fmt(gap)} pts {gap>=0?"above":"below"}</span>
          </div>;
        })}
      </div>
      <p className="mt-2 text-[11px] text-slate-500">Positive means the team's alliance residual was higher than its opponents' average residual; negative means it was lower. Every scored same-match opponent is included—no EPA similarity filter is applied. This is descriptive, not a causal comparison. This is an alliance-level comparison, not an individual-robot rating. Small event counts describe direction, not statistical certainty.</p>
    </> : <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
      <p className="font-semibold">Not enough usable match data yet.</p>
      <p className="mt-1">No arbitrary sample minimum is applied. Every event with at least one scored team match and a usable opposing-alliance residual is included; sample counts are shown so small samples remain obvious.</p>
      {result.diagnostics?.length ? <div className="mt-2 space-y-1">{result.diagnostics.map((item)=><div key={item.event.key} className="flex flex-wrap justify-between gap-x-3"><span>{item.event.name}</span><span className="font-mono tabular-nums">{item.matches} matches · {item.scoredMatches} scored · {item.teamResidualSamples} team residuals · {item.baselineAllianceSamples} opponent samples</span></div>)}</div> : null}
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
  const [phaseFilter,setPhaseFilter]=useState<"all"|"qualification"|"playoffs">("all");
  const [selectedComponents,setSelectedComponents]=useState<Array<"auto"|"teleop"|"endgame">>(["auto","teleop","endgame"]);
  const allMatches=[...analysis.matches].sort((a,b)=>a.event.startDate.localeCompare(b.event.startDate)||a.event.key.localeCompare(b.event.key)||a.matchKey.localeCompare(b.matchKey,undefined,{numeric:true}));
  const matches=allMatches.filter((match)=>phaseFilter==="all"||
    (phaseFilter==="qualification"?match.compLevel.toLowerCase()==="qm":["ef","qf","sf","f"].includes(match.compLevel.toLowerCase())));
  const epaValues=matches.flatMap((m)=>[m.preEPA,m.postEPA]).filter((v):v is number=>v!==null);
  const epaMin=Math.min(0,...epaValues), epaMax=Math.max(1,...epaValues);
  const epaRange=Math.max(1,epaMax-epaMin);
  const x=(i:number)=>matches.length<2?450:54+i*800/(matches.length-1);
  const y=(v:number)=>214-(v-epaMin)/epaRange*166;
  const residuals=matches.filter((m)=>m.residual!==null);
  const residualMax=Math.max(1,...residuals.map((m)=>Math.abs(m.residual??0)));
  const componentRows=[
    {key:"auto_epa",actual:"auto",label:"Auto",id:"auto" as const},
    {key:"teleop_epa",actual:"teleop",label:"Teleop",id:"teleop" as const},
  ].filter((row)=>selectedComponents.includes(row.id));
  const componentSeries=componentRows.map((row)=>({...row,points:matches.flatMap((m,i)=>{const estimate=m.alliancePreComponents[row.key],actual=m.actualComponents[row.actual];return typeof estimate==="number"&&typeof actual==="number"?[{i,estimate,actual,match:m}]:[];})}));
  const endgameSeries=selectedComponents.includes("endgame")?matches.flatMap((match)=>{const before=match.preComponents.endgame_epa,after=match.postComponents.endgame_epa;return typeof before==="number"&&typeof after==="number"?[{match,before,after,delta:after-before}]:[]}):[];
  const eventGroups=matches.reduce<{key:string;label:string;items:{match:TeamMatchRow;index:number}[]}[]>((groups,match,index)=>{
    let group=groups[groups.length-1];
    if(!group||group.key!==match.event.key){group={key:match.event.key,label:match.event.name,items:[]};groups.push(group);}
    group.items.push({match,index});return groups;
  },[]);
  const eventBoundaries=eventGroups.slice(1).map((group)=>x(group.items[0].index)-800/(Math.max(1,matches.length-1))/2);
  const allianceColor=(alliance:"red"|"blue")=>alliance==="red"?"#e11d48":"#2563eb";
  const componentChartWidth=Math.max(900,componentSeries.reduce((max,s)=>Math.max(max,s.points.length*54+80),900));
  return <section className="min-w-0 rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-bold text-slate-900">{name}</h3><p className="text-xs text-slate-500">Season match analysis · {matches.length} of {allMatches.length} matches shown across {analysis.eventCount} events</p></div><a className="text-xs font-semibold text-slate-600 hover:underline" href={`https://www.thebluealliance.com/team/${analysis.team}/${analysis.year}`} target="_blank" rel="noreferrer">TBA history ↗</a></div>
    <div className="mt-3 flex flex-wrap items-center gap-4 rounded-lg bg-slate-50 p-3">
      <div><p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">Match phase</p><div className="flex flex-wrap gap-1">{([{id:"all",label:"All"},{id:"qualification",label:"Qualifications"},{id:"playoffs",label:"Playoffs"}] as const).map((option)=><button key={option.id} type="button" aria-pressed={phaseFilter===option.id} onClick={()=>setPhaseFilter(option.id)} className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold ${phaseFilter===option.id?"border-blue-300 bg-blue-100 text-blue-800":"border-slate-200 bg-white text-slate-600 hover:bg-slate-100"}`}>{option.label}</button>)}</div></div>
      <div><p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">EPA components</p><div className="flex flex-wrap gap-1">{([{id:"auto",label:"Auto"},{id:"teleop",label:"Teleop"},{id:"endgame",label:"Endgame"}] as const).map((option)=><button key={option.id} type="button" aria-pressed={selectedComponents.includes(option.id)} onClick={()=>setSelectedComponents((current)=>current.includes(option.id)?current.filter((item)=>item!==option.id):[...current,option.id])} className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold ${selectedComponents.includes(option.id)?"border-teal-300 bg-teal-50 text-teal-800":"border-slate-200 bg-white text-slate-600 hover:bg-slate-100"}`}>{option.label}</button>)}</div></div>
    </div>
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
      <p className="mt-1 text-[10px] text-slate-500">Select any combination of Auto, Teleop, and Endgame above. Phase selection filters all match-based charts and records.</p>
      <p className="text-[11px] text-slate-500">Auto and teleop compare pre-match alliance EPA estimates with TBA's recorded alliance scores. Endgame is shown separately as a change in the selected team's Statbotics EPA estimate.</p>
      {componentSeries.length===0&&!selectedComponents.includes("endgame")?<p className="mt-3 text-xs text-slate-500">Select at least one EPA component to display its match comparison.</p>:null}
      <div className="mt-3 space-y-5">{componentSeries.map((series)=><div key={series.key} className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold text-slate-800">{series.label}</span><span className="text-[10px] text-slate-400">n={series.points.length}</span></div>
        {series.points.length?<div className="overflow-x-auto"><svg viewBox={`0 0 ${componentChartWidth} 250`} role="img" aria-label={`${series.label} alliance EPA estimates versus actual scores by match`} className="w-full min-w-[900px]">
          {(() => {const values=series.points.flatMap((point)=>[point.estimate,point.actual]);const min=Math.min(0,...values),max=Math.max(1,...values),range=Math.max(1,max-min),baseline=190-(0-min)/range*140;const y=(value:number)=>190-(value-min)/range*140;return <>{[0,1,2,3].map((n)=>{const value=max-range*n/3,gridY=y(value);return <g key={n}><line x1="55" x2={componentChartWidth-20} y1={gridY} y2={gridY} stroke="var(--insights-gridline)" strokeDasharray="3 4"/><text x="48" y={gridY+4} textAnchor="end" fontSize="10" fill="var(--insights-muted)">{value.toFixed(0)}</text></g>;})}<line x1="55" x2={componentChartWidth-20} y1={baseline} y2={baseline} stroke="var(--insights-muted)" strokeWidth="1.5"/>{series.points.map((point,index)=>{const step=(componentChartWidth-90)/Math.max(1,series.points.length);const bw=Math.min(17,step*0.34);const base=60+index*step;const estimateY=y(point.estimate),actualY=y(point.actual);return <g key={point.match.matchKey}><rect x={base} y={Math.min(baseline,estimateY)} width={bw} height={Math.max(1,Math.abs(baseline-estimateY))} rx="2" fill={allianceColor(point.match.alliance)}><title>{point.match.event.shortName??point.match.event.name} · {point.match.matchLabel}: EPA estimate {point.estimate.toFixed(1)}</title></rect><rect x={base+bw+2} y={Math.min(baseline,actualY)} width={bw} height={Math.max(1,Math.abs(baseline-actualY))} rx="2" fill="#94a3b8"><title>{point.match.event.shortName??point.match.event.name} · {point.match.matchLabel}: actual {point.actual.toFixed(1)}</title></rect><text transform={`translate(${base+bw},210) rotate(-45)`} textAnchor="end" fontSize="9" fill="var(--insights-muted)">{point.match.matchLabel}</text></g>;})}</>;})()}
        </svg></div>:<p className="text-xs text-slate-500">No complete {series.label.toLowerCase()} estimate/outcome pairs.</p>}
      </div>)}</div>
      <div className="flex flex-wrap gap-4 text-[10px] text-slate-500"><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-rose-600"/>EPA estimate · red alliance</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-blue-600"/>EPA estimate · blue alliance</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-slate-400"/>Actual alliance score</span></div>
      <p className="mt-2 text-[10px] text-slate-500">Hover bars for match values. These are alliance-level auto/teleop comparisons, not individual robot scoring.</p>
      <div className="mt-5 border-t border-slate-100 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold text-slate-800">Endgame EPA change by match</h4><span className="text-[10px] text-slate-400">n={endgameSeries.length} · team-level estimate</span></div>
        <p className="mt-1 text-[11px] text-slate-500">Statbotics endgame EPA after the match minus before the match. Positive and negative changes indicate model movement, not actual endgame points scored.</p>
        {endgameSeries.length?<div className="mt-2 overflow-x-auto"><svg viewBox={`0 0 ${Math.max(900,endgameSeries.length*42+80)} 220`} role="img" aria-label={`${name} endgame EPA change by match`} className="w-full min-w-[900px]">
          {(() => {const width=Math.max(900,endgameSeries.length*42+80),maxAbs=Math.max(1,...endgameSeries.map((item)=>Math.abs(item.delta))),zero=92;return <><line x1="50" x2={width-20} y1={zero} y2={zero} stroke="var(--insights-muted)" strokeWidth="1.5"/>{endgameSeries.map((item,index)=>{const x=60+index*42,h=Math.abs(item.delta)/maxAbs*65,y=item.delta>=0?zero-h:zero;return <g key={item.match.matchKey}><rect x={x} y={y} width="20" height={Math.max(1,h)} rx="2" fill={item.delta>=0?"#0d9488":"#e11d48"}><title>{item.match.event.name} · {item.match.matchLabel}: endgame EPA {item.before.toFixed(2)} → {item.after.toFixed(2)} ({item.delta>0?"+":""}{item.delta.toFixed(2)})</title></rect><text transform={`translate(${x+10},180) rotate(-48)`} textAnchor="end" fontSize="9" fill="var(--insights-muted)">{item.match.matchLabel}</text></g>;})}</>;})()}
        </svg></div>:<p className="mt-2 text-xs text-slate-500">{selectedComponents.includes("endgame")?"Statbotics endgame EPA snapshots are unavailable for these matches.":"Endgame is hidden by the component filter."}</p>}
      </div>
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
  const max=Math.max(1,...shared.flatMap((item)=>[Math.abs(item.av),Math.abs(item.bv)]));
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
        {[{value:av,color:"bg-blue-600"},{value:bv,color:"bg-teal-600"}].map((item,index)=><div key={index} className="min-w-0"><div className="mb-1 flex justify-between gap-1"><span className="text-[10px] text-slate-400">{index===0?nameA:nameB}</span><strong className="tabular-nums">{fmt(item.value)}</strong></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className={"h-full rounded-full "+item.color} style={{width:`${Math.max(1,Math.abs(item.value)/max*100)}%`}} /></div></div>)}
      </div>;
    })}</div>
  </section>;
}
function TeamSeasonProfile({history,accent}:{history:TeamSeasonHistory;accent:"blue"|"teal"}) {
  const events=history.events.filter((item)=>typeof item.statbotics?.epa?.total_points==="number").sort((a,b)=>a.event.start_date.localeCompare(b.event.start_date));
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
  const points=events.flatMap((item)=>typeof item.statbotics?.epa?.total_points==="number"?[{label:item.event.name,date:item.event.start_date,value:item.statbotics.epa.total_points}]:[]).sort((a,b)=>a.date.localeCompare(b.date));
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
  type SortKey = "qualRank" | "epaRank" | "teamNumber" | "qualRecord" | "epa" | "epaShare" | "auto" | "teleop" | "endgame" | "performance";
  type SortRule = { key: SortKey; direction: "asc" | "desc" };
  const [sortRules, setSortRules] = useState<SortRule[]>([{ key: "qualRank", direction: "asc" }]);
  const teamByKey=new Map(data.teams.map((team)=>[team.teamKey,team]));
  const rankings=data.rankings?.rankings??[];
  const completedMatches=data.matches.filter(({match})=>match.alliances.red.score>=0&&match.alliances.blue.score>=0).length;
  const rankedTeams=rankings.map((ranking)=>({ranking,team:teamByKey.get(ranking.team_key)})).filter((item)=>item.team).sort((a,b)=>a.ranking.rank-b.ranking.rank);
  const epaTeams=[...data.teams].sort((a,b)=>(b.epa??-Infinity)-(a.epa??-Infinity));
  const qualificationLeader=rankedTeams[0];
  const highestEpaTeam=epaTeams.find((team)=>team.epa!==null);
  const leadFinding=data.findings[0];
  const insights=data.teamInsights??[];
  const comparisons=insights.flatMap((item)=>item.seasonComparison?[{teamNumber:item.teamNumber,comparison:item.seasonComparison}]:[]);
  const improved=[...comparisons].sort((a,b)=>b.comparison.change-a.comparison.change).slice(0,5);
  const declined=[...comparisons].sort((a,b)=>a.comparison.change-b.comparison.change).slice(0,5);
  const predictionResidualValues=data.allianceResults.filter((item)=>item.actual!==null&&item.residual!==null).map((item)=>item.residual as number);
  const predictionResidualMean=predictionResidualValues.length?predictionResidualValues.reduce((sum,value)=>sum+value,0)/predictionResidualValues.length:null;
  const predictionResidualSampleSd=predictionResidualValues.length>1&&predictionResidualMean!==null?Math.sqrt(predictionResidualValues.reduce((sum,value)=>sum+(value-predictionResidualMean)**2,0)/(predictionResidualValues.length-1)):null;
  const residualDiagnostics=data.teams.map((team)=>{
    const values=data.allianceResults
      .filter((item)=>item.teamKeys.includes(team.teamKey)&&item.actual!==null&&item.residual!==null)
      .map((item)=>item.residual as number);
    const count=values.length;
    const mean=count?values.reduce((sum,value)=>sum+value,0)/count:null;
    const variance=count>1?values.reduce((sum,value)=>sum+(value-(mean as number))**2,0)/(count-1):null;
    // Small samples need a wider interval than the normal 1.96 multiplier.
    const tCritical=[0,12.706,4.303,3.182,2.776,2.571,2.447,2.365,2.306,2.262,2.228,2.201,2.179,2.160,2.145,2.131,2.120,2.110,2.101,2.093,2.086,2.080,2.074,2.069,2.064,2.060,2.056,2.052,2.048,2.045,2.042];
    const multiplier=count>=32?1.96:tCritical[count-1]??1.96;
    const margin=variance===null?null:multiplier*Math.sqrt(variance/count);
    const significant=count>=3&&mean!==null&&margin!==null&&Math.abs(mean)>margin;
    return {team,mean,margin,count,significant};
  });
  const residuals=residualDiagnostics.flatMap((item)=>item.significant&&item.mean!==null&&item.margin!==null?[{...item,mean:item.mean,margin:item.margin}]:[]);
  const over=residuals.filter((item)=>(item.mean??0)>0).sort((a,b)=>(b.mean??0)-(a.mean??0)).slice(0,5);
  const under=residuals.filter((item)=>(item.mean??0)<0).sort((a,b)=>(a.mean??0)-(b.mean??0)).slice(0,5);
  const performanceStatus=(teamKey:string)=>{
    const item=residualDiagnostics.find((entry)=>entry.team.teamKey===teamKey);
    if(!item||item.count===0)return {label:"No usable samples",tone:"bg-slate-100 text-slate-700"};
    if(item.count<3)return {label:"Insufficient sample",tone:"bg-slate-100 text-slate-700"};
    if(item.significant&&item.mean!==null&&item.mean>0)return {label:"Above prediction",tone:"bg-emerald-50 text-emerald-800"};
    if(item.significant&&item.mean!==null&&item.mean<0)return {label:"Below prediction",tone:"bg-rose-50 text-rose-800"};
    if(item.mean!==null&&item.mean>0)return {label:"Above · inconclusive",tone:"bg-emerald-50 text-emerald-800"};
    if(item.mean!==null&&item.mean<0)return {label:"Below · inconclusive",tone:"bg-rose-50 text-rose-800"};
    return {label:"Near prediction",tone:"bg-slate-100 text-slate-700"};
  };
  const sortValue=(team:TeamAnalyticsRow,key:SortKey):number|string|null=>{
    const ranking=rankings.find((item)=>item.team_key===team.teamKey);
    const comparison=insights.find((item)=>item.teamNumber===team.teamNumber)?.seasonComparison;
    if(key==="qualRank")return ranking?.rank??null;
    if(key==="epaRank")return team.epa===null?null:1+epaTeams.filter((item)=>item.epa!==null&&item.epa>team.epa!).length;
    if(key==="teamNumber")return team.teamNumber;
    if(key==="qualRecord"){if(!ranking?.record)return null;const {wins,losses,ties}=ranking.record;const games=wins+losses+ties;return games?wins/games*1000000+wins*1000+ties:null;}
    if(key==="epa")return comparison?.currentEPA??team.epa;
    if(key==="epaShare")return team.epaContributionPercent;
    if(key==="auto")return comparison?.components.auto?.current??team.autoEpa;
    if(key==="teleop")return comparison?.components.teleop?.current??team.teleopEpa;
    if(key==="endgame")return comparison?.components.endgame?.current??team.endgameEpa;
    return residualDiagnostics.find((item)=>item.team.teamKey===team.teamKey)?.mean??null;
  };
  const sortedTeams=[...data.teams].sort((a,b)=>{
    for(const rule of sortRules){const av=sortValue(a,rule.key),bv=sortValue(b,rule.key);if(av===null||av===undefined){if(bv===null||bv===undefined)continue;return 1;}if(bv===null||bv===undefined)return -1;const result=typeof av==="string"&&typeof bv==="string"?av.localeCompare(bv):Number(av)-Number(bv);if(result!==0)return result*(rule.direction==="asc"?1:-1);}
    return a.teamNumber-b.teamNumber;
  });
  const sortLabels:Record<SortKey,string>={qualRank:"Qual Rank",epaRank:"EPA Rank",teamNumber:"Team Number",qualRecord:"Qual Record",epa:"EPA",epaShare:"Avg EPA Share",auto:"Auto",teleop:"Teleop",endgame:"Endgame",performance:"Performance"};
  const defaultSortDirection=(key:SortKey):"asc"|"desc"=>["epa","epaShare","auto","teleop","endgame","performance","qualRecord"].includes(key)?"desc":"asc";
  const changeSort=(key:SortKey,additive:boolean)=>setSortRules((current)=>{const existing=current.find((rule)=>rule.key===key);const nextDirection=existing?(existing.direction==="asc"?"desc":"asc"):defaultSortDirection(key);if(!additive)return [{key,direction:nextDirection}];if(!existing)return [...current,{key,direction:nextDirection}];return current.map((rule)=>rule.key===key?{...rule,direction:nextDirection}:rule);});
  const sortHeader=(key:SortKey)=>{const index=sortRules.findIndex((rule)=>rule.key===key);const rule=sortRules[index];return <button type="button" onClick={(event)=>changeSort(key,event.shiftKey)} title={index>=0?"Sort priority "+(index+1)+"; Shift-click to change secondary sorting":"Click to sort; Shift-click to add as a secondary sort"} className="inline-flex items-center justify-center gap-1 whitespace-nowrap text-center hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"><span>{sortLabels[key]}</span>{rule?<span aria-hidden="true" className="inline-flex items-center gap-0.5">{rule.direction==="asc"?<ChevronUpIcon className="h-4 w-4"/>:<ChevronDownIcon className="h-4 w-4"/>}{index>0?<sup>{index+1}</sup>:null}</span>:<span aria-hidden="true" className="text-slate-300">↕</span>}</button>;};
  const movement=(items:typeof comparisons,empty:string)=><ol className="space-y-2">{items.length?items.map(({teamNumber,comparison})=><li key={teamNumber} className="flex items-center justify-between gap-3 border-b border-slate-100 pb-2 last:border-0"><div className="min-w-0">{teamNumberLink(teamNumber)}<span className="ml-2 text-[10px] text-slate-400">{comparison.priorEvent.name}</span></div><div className="shrink-0 text-right"><span className="block text-[10px] text-slate-500">#{comparison.cohortRank} of {comparison.cohortSize}</span><strong className={"tabular-nums "+(comparison.change>=0?"text-emerald-700":"text-rose-700")}>{comparison.change>0?"+":""}{fmt(comparison.change)}</strong></div></li>):<li className="text-sm text-slate-500">{empty}</li>}</ol>;
  const residualList=(items:typeof residuals,empty:string)=><ol className="space-y-2">{items.length?items.map((item,index)=><li key={item.team.teamKey} className="flex items-center justify-between gap-3 border-b border-slate-100 pb-2 last:border-0"><div className="min-w-0"><span className="mr-2 text-xs text-slate-400">#{index+1}</span>{teamNumberLink(item.team.teamNumber)}</div><strong className={"shrink-0 tabular-nums "+(item.mean>0?"text-emerald-700":"text-rose-700")}>{item.mean>0?"+":""}{fmt(item.mean)} pts</strong></li>):<li className="text-sm text-slate-500">{empty}</li>}</ol>;
  return <div className="space-y-5">
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex flex-wrap items-end justify-between gap-2"><div><p className="text-xs font-bold uppercase tracking-wide text-blue-700">Event overview</p><h2 className="mt-1 text-lg font-bold text-slate-900">The competitive picture</h2><p className="mt-1 text-sm text-slate-500">Who is gaining ground, who is falling behind expectations, and where the model is being surprised.</p></div><span className="text-xs text-slate-500">{data.teams.length} teams · {completedMatches} scored matches represented</span></div>
      <div className="mt-4 rounded-lg bg-slate-50 p-3">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">At a glance</h3>
        <ul className="mt-2 grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          <li><span className="font-semibold text-slate-900">Qualification leader:</span> {qualificationLeader ? `Team ${qualificationLeader.team!.teamNumber} · rank ${qualificationLeader.ranking.rank}` : "Official rankings are not available yet."}</li>
          <li><span className="font-semibold text-slate-900">Highest available EPA:</span> {highestEpaTeam ? `Team ${highestEpaTeam.teamNumber} · ${fmt(highestEpaTeam.epa)} EPA` : "No team EPA estimates are available yet."}</li>
          <li><span className="font-semibold text-slate-900">Match coverage:</span> {completedMatches} scored matches represented; {data.collection.processedMatchCount} of {data.matchCount} scheduled matches processed for analysis.</li>
          <li><span className="font-semibold text-slate-900">Review signal:</span> {leadFinding ? leadFinding.title : "No findings currently meet the review thresholds."}</li>
        </ul>
      </div>
      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <Panel title="EPA Change from Last Event" description="Every team is compared with its own most recent prior official event, regardless of whether that event was attended by other teams here."><div className="grid gap-4 sm:grid-cols-2"><div><p className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-700">Largest EPA Gain</p>{movement(improved,"No usable prior-event comparisons yet.")}</div><div><p className="mb-2 text-xs font-bold uppercase tracking-wide text-rose-700">Largest EPA Decline</p>{movement(declined,"No usable prior-event comparisons yet.")}</div></div><p className="mt-3 text-[11px] leading-5 text-slate-500">{comparisons.length} of {data.teams.length} event teams have usable current and most-recent-prior-event EPA records. Others remain included in event standings and analysis. EPA is a predictive model estimate, not measured scoring improvement.</p></Panel>
        <Panel title="Outside the margin of error" description="Teams whose average alliance score residual is distinguishable from zero after accounting for sample size."><div className="grid gap-4 sm:grid-cols-2"><div><p className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-700">Above prediction</p>{residualList(over,"No teams currently clear the positive uncertainty band.")}</div><div><p className="mb-2 text-xs font-bold uppercase tracking-wide text-rose-700">Below prediction</p>{residualList(under,"No teams currently clear the negative uncertainty band.")}</div></div><p className="mt-3 text-[11px] leading-5 text-slate-500">Residual = actual alliance score − Statbotics predicted alliance score. Each observation belongs to the team's own alliance and includes its two alliance partners; it does not include the opposing alliance. The uncertainty margin uses a two-sided 95% t interval (minimum three scored samples). Alliance-level results cannot isolate one robot's contribution.</p></Panel>
      </div>
    </section>
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div><h3 className="text-base font-bold text-slate-900">Event standings and team performance</h3><p className="mt-1 text-xs text-slate-500">Qualification rank, current EPA standing, alliance contribution, component estimates, and performance against prediction.</p></div>
        <span className="text-xs text-slate-500">{data.teams.length} event teams</span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[1120px] table-fixed text-sm">
          
          <thead className="bg-white"><tr className="border-b text-[10px] uppercase tracking-wide text-slate-400">
            <th aria-sort={sortRules[0]?.key==="qualRank"?(sortRules[0].direction==="asc"?"ascending":"descending"):"none"} className="whitespace-nowrap px-1 py-2 text-center">{sortHeader("qualRank")}</th><th aria-sort={sortRules[0]?.key==="epaRank"?(sortRules[0].direction==="asc"?"ascending":"descending"):"none"} className="whitespace-nowrap px-1 text-center">{sortHeader("epaRank")}</th><th aria-sort={sortRules[0]?.key==="teamNumber"?(sortRules[0].direction==="asc"?"ascending":"descending"):"none"} className="whitespace-nowrap px-1 text-center">{sortHeader("teamNumber")}</th><th aria-sort={sortRules[0]?.key==="qualRecord"?(sortRules[0].direction==="asc"?"ascending":"descending"):"none"} className="whitespace-nowrap px-1 text-center">{sortHeader("qualRecord")}</th><th aria-sort={sortRules[0]?.key==="epa"?(sortRules[0].direction==="asc"?"ascending":"descending"):"none"} className="whitespace-nowrap px-1 text-center">{sortHeader("epa")}</th><th aria-sort={sortRules[0]?.key==="epaShare"?(sortRules[0].direction==="asc"?"ascending":"descending"):"none"} className="hidden whitespace-nowrap px-1 text-center xl:table-cell">{sortHeader("epaShare")}</th><th aria-sort={sortRules[0]?.key==="auto"?(sortRules[0].direction==="asc"?"ascending":"descending"):"none"} className="hidden whitespace-nowrap px-1 text-center xl:table-cell">{sortHeader("auto")}</th><th aria-sort={sortRules[0]?.key==="teleop"?(sortRules[0].direction==="asc"?"ascending":"descending"):"none"} className="hidden whitespace-nowrap px-1 text-center xl:table-cell">{sortHeader("teleop")}</th><th aria-sort={sortRules[0]?.key==="endgame"?(sortRules[0].direction==="asc"?"ascending":"descending"):"none"} className="hidden whitespace-nowrap px-1 text-center xl:table-cell">{sortHeader("endgame")}</th><th aria-sort={sortRules[0]?.key==="performance"?(sortRules[0].direction==="asc"?"ascending":"descending"):"none"} className="whitespace-nowrap px-1 text-center">{sortHeader("performance")}</th>
          </tr></thead>
          <tbody>{sortedTeams.map((team)=>{
            const ranking=rankings.find((item)=>item.team_key===team.teamKey);
            const epaRank=team.epa===null?null:1+epaTeams.filter((item)=>item.epa!==null&&item.epa>team.epa!).length;
            const comparison=insights.find((item)=>item.teamNumber===team.teamNumber)?.seasonComparison;
            const auto=comparison?.components.auto??null;
            const teleop=comparison?.components.teleop??null;
            const endgame=comparison?.components.endgame??null;
            const status=performanceStatus(team.teamKey);
            const trend=(change:number|null)=>change===null?<span aria-label="Previous event comparison unavailable" className="text-slate-400">—</span>:change===0?<span aria-label="No change since last event" className="text-slate-400">−</span>:<span aria-label={change>0?"Increased since last event":"Decreased since last event"} className={change>0?"text-emerald-600":"text-rose-600"}>{change>0?<ChevronUpIcon className="h-5 w-5"/>:<ChevronDownIcon className="h-5 w-5"/>}</span>;
            return <tr key={team.teamKey} className="border-b border-slate-100 last:border-0">
              <td className="whitespace-nowrap px-1 py-2 text-center font-bold tabular-nums">{ranking?.rank??"—"}</td>
              <td className="whitespace-nowrap px-1 text-center tabular-nums">{epaRank??"—"}</td>
              <th className="whitespace-nowrap px-1 text-center">{teamNumberLink(team.teamNumber)}</th>
              <td className="whitespace-nowrap px-1 text-center tabular-nums">{ranking?.record?ranking.record.wins+"–"+ranking.record.losses+"–"+ranking.record.ties:"—"}</td>
              <td className="whitespace-nowrap px-1 text-center font-semibold tabular-nums">{fmt(comparison?.currentEPA??team.epa)}</td>
              <td className="hidden whitespace-nowrap px-1 text-center tabular-nums xl:table-cell" title={`Based on ${team.epaContributionSamples} matches with complete pre-match EPA for all three alliance teams`}>{team.epaContributionPercent===null?"—":`${fmt(team.epaContributionPercent)}%`}<span className="block text-[9px] text-slate-400">n={team.epaContributionSamples}</span></td>
              <td className="hidden whitespace-nowrap px-1 text-center tabular-nums xl:table-cell"><span className="inline-flex items-center justify-center gap-1">{fmt(auto?.current??team.autoEpa)}{trend(auto?.change??null)}</span></td>
              <td className="px-2 text-right tabular-nums"><span className="inline-flex items-center justify-end gap-1">{fmt(teleop?.current??team.teleopEpa)}{trend(teleop?.change??null)}</span></td>
              <td className="px-2 text-right tabular-nums"><span className="inline-flex items-center justify-end gap-1">{fmt(endgame?.current??team.endgameEpa)}{trend(endgame?.change??null)}</span></td>
              <td className="whitespace-nowrap px-1 py-2 text-center"><span className={"inline-flex whitespace-nowrap rounded-full px-1.5 py-1 text-[9px] font-semibold "+status.tone}>{status.label}</span></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] leading-5 text-slate-500">Columns size to their contents without wrapping, and values are centered for consistency. EPA share and component columns are shown on extra-large screens to keep the table within narrower viewports. Click a column heading to sort by it; Shift-click additional headings to add secondary sort priorities. Click a selected heading again to reverse its direction. Component chevrons compare with the team's most recent preceding official event. Average EPA share is based on matches with complete pre-match EPA for all three alliance teams. Performance describes alliance score residuals versus Statbotics predictions and cannot isolate an individual robot.</p>
    </section>
    <Panel title="Prediction diagnostics" description="How well Statbotics predictions aligned with actual alliance scores and match winners in the loaded sample."><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><QualityMetric label="Mean absolute error" value={fmt(data.predictionStats.meanAbsoluteError)} unit="pts" detail="Average size of an alliance score miss"/><QualityMetric label="Root mean square error" value={fmt(data.predictionStats.rootMeanSquareError)} unit="pts" detail="Weights larger misses more heavily"/><QualityMetric label="Within ±25 points" value={data.predictionStats.allianceCount?(data.predictionStats.within25Count/data.predictionStats.allianceCount*100).toFixed(1)+"%":"—"} detail={data.predictionStats.within25Count+" of "+data.predictionStats.allianceCount+" alliance scores"}/><QualityMetric label="Winner accuracy" value={data.predictionStats.winPredictionAccuracy===null?"—":(data.predictionStats.winPredictionAccuracy*100).toFixed(1)+"%"} detail={data.predictionStats.winPredictionCount+" decided matches"}/></div><div className="mt-4 rounded-lg bg-slate-50 p-3"><p className="text-xs font-semibold text-slate-600">Prediction bias</p><p className="mt-1 text-xl font-black tabular-nums">{data.predictionStats.meanResidual===null?"—":(data.predictionStats.meanResidual>0?"+":"")+fmt(data.predictionStats.meanResidual)+" pts"}</p><p className="text-xs text-slate-500">Positive means predictions tended low; negative means predictions tended high. Sample residual SD: {fmt(predictionResidualSampleSd)} pts across {predictionResidualValues.length} alliance results.</p></div></Panel>
  </div>;
}


function ReviewQueue({data}:{data:EventAnalyticsResponse}) {
  const tabs:{id:"all"|MatchReviewFlag;label:string}[]=[
    {id:"all",label:"All flags"},
    {id:"model-upset",label:"Model upsets"},
    {id:"anomalous-score",label:"Anomalous scores"},
    {id:"large-residual",label:"Large residuals"},
    {id:"high-penalties",label:"High penalties"},
    {id:"high-alliance-epa",label:"High alliance EPA"},
  ];
  const [active,setActive]=useState<"all"|MatchReviewFlag>("all");
  const records=[...data.matches].map((record)=>({record,summary:buildMatchFlagSummary(data,record)}))
    .filter(({summary})=>summary.reviewFlags.length>0)
    .sort((a,b)=>{
      const at=a.record.match.time??a.record.match.actual_time??a.record.match.predicted_time;
      const bt=b.record.match.time??b.record.match.actual_time??b.record.match.predicted_time;
      if(at!==null&&at!==undefined&&bt!==null&&bt!==undefined&&at!==bt)return at-bt;
      const order=["qm","ef","qf","sf","f"];
      return order.indexOf(a.record.match.comp_level)-order.indexOf(b.record.match.comp_level)||a.record.match.set_number-b.record.match.set_number||a.record.match.match_number-b.record.match.match_number;
    });
  const visible=active==="all"?records:records.filter(({summary})=>summary.reviewFlags.includes(active));
  const counts=new Map(tabs.map((tab)=>[tab.id,tab.id==="all"?records.length:records.filter(({summary})=>summary.reviewFlags.some((flag)=>flag===tab.id)).length]));
  const timezone=data.event.timezone??null;
  const formatTime=(timestamp:number|null|undefined)=>{
    if(timestamp===null||timestamp===undefined||!timezone)return null;
    try{return new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",timeZone:timezone}).format(new Date(timestamp*1000));}
    catch{return null;}
  };
  const teamLabel=(key:string)=>{const team=data.teams.find((item)=>item.teamKey===key);return team?String(team.teamNumber)+" · "+team.name:formatTeamNumber(key);};
  const flagLabels:Record<MatchReviewFlag,string>={
    "model-upset":"Model Upset",
    "anomalous-score":"Anomalous Score",
    "large-residual":"Large Score Delta",
    "high-penalties":"High Penalties",
    "high-alliance-epa":"High Alliance EPA",
  };
  const flagReasons=(record:EventAnalyticsResponse["matches"][number],summary:MatchFlagSummary)=>{
    const reasons:string[]=[];
    const {match,statbotics}=record;
    if(summary.modelUpset&&summary.predictedWinner&&summary.winner){
      const p=statbotics?.pred?.red_win_prob??0;
      const favorite=summary.predictedWinner==="red"?"Red":"Blue";
      reasons.push(favorite+" was favored at "+Math.round(Math.max(p,1-p)*100)+"%, but "+(summary.winner==="red"?"Red":"Blue")+" won.");
    }
    if(summary.anomalousScore){
      const band=phaseAnomalyBand(data,match.comp_level);
      if(band)for(const item of data.allianceResults.filter((result)=>result.matchKey===match.key&&result.residual!==null&&Math.abs(result.residual-band.median)>band.margin))reasons.push((item.color==="red"?"Red":"Blue")+" alliance residual "+(item.residual!>0?"+":"")+fmt(item.residual)+" pts fell outside the phase baseline ("+(band.median>0?"+":"")+fmt(band.median)+" ± "+fmt(band.margin)+" pts).");
    }
    if(summary.largeResidual.red||summary.largeResidual.blue){
      for(const item of data.allianceResults.filter((result)=>result.matchKey===match.key&&result.residual!==null&&summary.largeResidual[result.color])){
        reasons.push((item.color==="red"?"Red":"Blue")+" alliance score delta: "+(item.residual!>0?"+":"")+fmt(item.residual)+" pts (absolute delta in the event-wide top decile).");
      }
    }
    if(summary.highPenalties.red||summary.highPenalties.blue){
      const item=data.qualificationAnalysis?.penalties.flaggedMatches.find((entry)=>entry.matchKey===match.key);
      if(item){
        if(item.redFlagged)reasons.push("Red alliance: "+(item.redPenaltyCount===null?"penalty count unavailable":item.redPenaltyCount+" penalties")+", "+item.redPenaltyPoints+" credited penalty points (above the alliance outlier threshold).");
        if(item.blueFlagged)reasons.push("Blue alliance: "+(item.bluePenaltyCount===null?"penalty count unavailable":item.bluePenaltyCount+" penalties")+", "+item.bluePenaltyPoints+" credited penalty points (above the alliance outlier threshold).");
      }
    }
    if(summary.highAllianceEpa.red||summary.highAllianceEpa.blue){
      const high=data.allianceResults.filter((item)=>item.matchKey===match.key&&summary.highAllianceEpa[item.color]);
      for(const item of high)reasons.push((item.color==="red"?"Red":"Blue")+" alliance pre-match EPA: "+fmt(item.preEpaTotal)+" (top quartile).");
    }
    return reasons;
  };
  return <Panel title="Suggested review" description="Flagged matches in event schedule order. Tabs group the matches by the reason they deserve a closer look; a match can appear in more than one group.">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-slate-600">{records.length} flagged matches · {data.matches.length} matches evaluated</p><a href={"https://www.thebluealliance.com/event/"+data.event.key+"#matches"} target="_blank" rel="noreferrer" className="text-xs font-semibold text-blue-700 hover:underline">Full event schedule ↗</a></div>
    <p className="mb-3 text-xs leading-5 text-slate-500">Anomalous Score uses an event- and match-phase baseline: actual-minus-predicted alliance residuals outside the median ± max(20 points, 3 × 1.4826 × MAD), with at least 8 usable alliance scores in that phase. Large Score Delta is alliance-specific: an absolute actual-minus-predicted score delta in the event-wide top decile, requiring at least 20 usable alliance scores. Model Upset means the pre-match favorite had at least 60% win probability and lost. These are review signals, not robot-level diagnoses.</p>
    <div role="tablist" aria-label="Review flags by type" className="no-scrollbar flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.filter((tab)=>tab.id==="all"||counts.get(tab.id)!>0).map((tab)=><button key={tab.id} type="button" role="tab" aria-selected={active===tab.id} onClick={()=>setActive(tab.id)} className={"shrink-0 border-b-2 px-3 py-2.5 text-xs font-semibold "+(active===tab.id?"border-blue-600 text-blue-700":"border-transparent text-slate-500 hover:text-slate-800")}>{tab.label} <span className="ml-1 rounded-full bg-slate-100 px-1.5 py-0.5 tabular-nums text-slate-600">{counts.get(tab.id)}</span></button>)}
    </div>
    {!visible.length?<p className="py-8 text-center text-sm text-slate-500">No matches currently carry this flag.</p>:<div className="mt-3 space-y-3">
      {visible.map(({record,summary})=>{
        const {match}=record;
        const timestamp=match.time??match.actual_time??match.predicted_time;
        const timeLabel=formatTime(timestamp);
        const youtube=match.videos.find((video)=>video.type.toLowerCase()==="youtube");
        const videoUrl=youtube?"https://www.youtube.com/watch?v="+encodeURIComponent(youtube.key):null;
        const red=match.alliances.red,blue=match.alliances.blue;
        const reasons=flagReasons(record,summary);
        const displayedFlags=summary.reviewFlags;
        return <article key={match.key} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-bold text-slate-950 dark:text-white">{matchShortName(match,data.event.playoff_type)}</h3>{timeLabel?<span className="text-xs tabular-nums text-slate-500">{timeLabel} <span className="text-slate-400">{timezone}</span></span>:null}</div><p className="mt-1 text-xs text-slate-500">{data.event.name}</p></div>
            <div className="flex flex-wrap gap-2">
              <a href={"https://www.thebluealliance.com/match/"+match.key} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200">Match details ↗</a>
              {videoUrl?<a href={videoUrl} target="_blank" rel="noreferrer" className="rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800">Watch video ↗</a>:<a href={"https://www.thebluealliance.com/match/"+match.key+"#videos"} target="_blank" rel="noreferrer" className="rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50 dark:border-blue-900 dark:text-blue-300">Match videos ↗</a>}
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border-l-4 border-rose-500 bg-rose-50 p-3 dark:bg-rose-950/40"><p className="text-[10px] font-bold uppercase tracking-wide text-rose-800 dark:text-rose-200">Red alliance · {red.score>=0?red.score:"—"}</p><p className="mt-1 text-sm font-semibold leading-6 text-slate-900 dark:text-slate-100">{red.team_keys.map(teamLabel).join(" · ")}</p></div>
            <div className="rounded-lg border-l-4 border-blue-500 bg-blue-50 p-3 dark:bg-blue-950/40"><p className="text-[10px] font-bold uppercase tracking-wide text-blue-800 dark:text-blue-200">Blue alliance · {blue.score>=0?blue.score:"—"}</p><p className="mt-1 text-sm font-semibold leading-6 text-slate-900 dark:text-slate-100">{blue.team_keys.map(teamLabel).join(" · ")}</p></div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {summary.prediction?<span className={"rounded-full px-2 py-1 text-[10px] font-bold "+summary.prediction.tone}>{summary.prediction.label}</span>:null}
            {displayedFlags.map((flag)=><span key={flag} className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold text-amber-900 dark:bg-amber-950 dark:text-amber-200">{flagLabels[flag]}</span>)}
          </div>
          {reasons.length?<ul className="mt-3 space-y-1.5 border-t border-slate-100 pt-3 text-sm leading-5 text-slate-700 dark:border-slate-800 dark:text-slate-300">{reasons.map((reason,index)=><li key={index} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"/><span>{reason}</span></li>)}</ul>:null}
        </article>;
      })}
    </div>}
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
