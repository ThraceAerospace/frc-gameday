"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EventAnalyticsResponse, ReviewFinding, TeamAnalyticsRow } from "@/lib/insights/types";
import type { StatboticsTeamEvent, StatboticsTeamYear } from "@/lib/statbotics/types";

type TeamSeasonHistory = { team: { nickname?: string | null; name?: string | null }; season: StatboticsTeamYear | null; events: { event: { key: string; name: string; short_name?: string | null; start_date: string; week?: number | null }; statbotics: StatboticsTeamEvent | null; status: "ready" | "unavailable" }[] };
type Tab = "review" | "teams" | "unexpected" | "quality" | "alliances";
const TABS: { id: Tab; label: string }[] = [
  { id: "review", label: "Review queue" },
  { id: "teams", label: "Team comparison" },
  { id: "unexpected", label: "Unexpected results" },
  { id: "quality", label: "Prediction quality" },
  { id: "alliances", label: "Alliance patterns" },
];
const fmt = (value: number | null | undefined, digits = 1) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
const percentileLabel = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}th`;

export default function EventAnalyticsDashboard({ eventKey, eventName, liveMatchKey, liveMatchSignature, websocketStatus, websocketStale }: { eventKey: string; eventName: string; liveMatchKey: string | null; liveMatchSignature: string; websocketStatus: "connected" | "disconnected" | "connecting"; websocketStale: boolean }) {
  const [data, setData] = useState<EventAnalyticsResponse | null>(null);
  const [tab, setTab] = useState<Tab>("review");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [teamA, setTeamA] = useState("");
  const [teamB, setTeamB] = useState("");
  const [historyA, setHistoryA] = useState<TeamSeasonHistory | null>(null);
  const [historyB, setHistoryB] = useState<TeamSeasonHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const load = useCallback(async (refreshMatchKey: string | null = null) => {
    setLoading(true);
    setError(null);
    try {
      const liveQuery = refreshMatchKey ? `?liveMatchKey=${encodeURIComponent(refreshMatchKey)}` : "";
      const response = await fetch(`/api/insights/event/${encodeURIComponent(eventKey)}${liveQuery}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      const next = await response.json() as EventAnalyticsResponse;
      setData(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load analytics");
    } finally {
      setLoading(false);
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
    const delay = data.collection.state === "complete" || data.collection.state === "partial" ? 30_000 : 5_000;
    const timer = window.setTimeout(() => { void load(liveMatchKey); }, delay);
    return () => window.clearTimeout(timer);
  }, [data?.collection.state, data?.collection.processedMatchCount, data?.collection.updatedAt, load, liveMatchKey]);

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

  const teams = data?.teams ?? [];
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
          <p className="mt-2 max-w-3xl text-sm text-slate-500">Statistical signals to help scouts decide what deserves a closer look. These are model outputs and alliance-level results, not robot-specific observations.</p>
          <p className="mt-2 flex items-center gap-2 text-xs font-medium text-slate-500"><span className={`h-2 w-2 rounded-full ${websocketStatus === "connected" ? "bg-emerald-500" : websocketStatus === "connecting" ? "bg-amber-400" : "bg-slate-300"}`} />{websocketStatus === "connected" ? "Live event updates connected" : websocketStatus === "connecting" ? "Connecting to live event updates…" : "Live event updates disconnected"}{websocketStale ? " · Reconciliation pending" : ""}</p>
        </div>
        <Link href={`/event/${eventKey}`} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">Event details</Link>
      </div>

      {error && <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
      {loading && !data ? <div className="mt-8 rounded-xl border border-slate-200 bg-white p-8 text-sm text-slate-500">Loading event analytics…</div> : null}
      {data ? <>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Teams" value={teams.length} detail="TBA event roster" />
          <Metric label="Event matches" value={data.matchCount} detail="Full event schedule" />
          <Metric label="Analyzed matches" value={data.loadedMatchCount} detail="Statbotics records loaded" />
          <Metric label="Score residuals" value={data.residualStats.sampleSize} detail="Alliance samples with scores" />
        </div>
        <nav aria-label="Analytics views" className="no-scrollbar mt-6 flex gap-1 overflow-x-auto border-b border-slate-200">          {TABS.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`shrink-0 border-b-2 px-3 py-3 text-sm font-semibold ${tab === item.id ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>{item.label}</button>)}
        </nav>
        <div className="mt-5">
          {tab === "review" && <ReviewQueue findings={findings} />}
          {tab === "teams" && <section className="space-y-4">
            <Panel title="Compare teams" description="Compare distinct rating systems and the alliance outcomes in matches they appeared in. EPA and OPR are not interchangeable or competing measurements.">
              <div className="grid gap-3 sm:grid-cols-2">
                <TeamSelect label="Team A" teams={teams} value={teamA} onChange={setTeamA} />
                <TeamSelect label="Team B" teams={teams} value={teamB} onChange={setTeamB} />
              </div>
              {selectedA && selectedB ? <>
                <div className="mt-5 grid gap-3 md:grid-cols-2"><TeamCard team={selectedA} /><TeamCard team={selectedB} /></div>
                <p className="mt-4 text-xs leading-5 text-slate-500">Statbotics EPA estimates expected point contribution through its predictive model. TBA OPR/DPR/CCWM are linear score-attribution estimates. They are complementary views with different assumptions; a numerical gap between them is not itself a performance signal.</p><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[520px] text-sm"><thead><tr className="border-b text-left text-xs uppercase text-slate-400"><th className="py-2">Statbotics EPA / TBA OPR-DPR-CCWM</th><th>Team {selectedA.teamNumber}</th><th>Team {selectedB.teamNumber}</th></tr></thead><tbody>{[
                  ["Statbotics EPA", selectedA.epa, selectedB.epa], ["Auto EPA", selectedA.autoEpa, selectedB.autoEpa],
                  ["Teleop EPA", selectedA.teleopEpa, selectedB.teleopEpa], ["Endgame EPA", selectedA.endgameEpa, selectedB.endgameEpa],
                  ["TBA OPR", selectedA.opr, selectedB.opr], ["TBA DPR", selectedA.dpr, selectedB.dpr], ["TBA CCWM", selectedA.ccwm, selectedB.ccwm],
                ].map(([label, a, b]) => <tr key={String(label)} className="border-b border-slate-100"><th className="py-2 text-left font-medium text-slate-600">{label}</th><td className="py-2 tabular-nums">{fmt(a as number | null)}{String(label).includes("percentile") && a !== null ? "%" : ""}</td><td className="py-2 tabular-nums">{fmt(b as number | null)}{String(label).includes("percentile") && b !== null ? "%" : ""}</td></tr>)}</tbody></table></div>
                <p className="mt-3 text-xs text-slate-500">Matches featuring both teams in the loaded sample: {commonMatches.length}.</p>
                <div className="mt-5 border-t border-slate-200 pt-4">
                  <h3 className="font-semibold text-slate-900">Official-season EPA progression</h3>
                  <p className="mt-1 text-xs text-slate-500">Statbotics team-event snapshots across each team's TBA-listed official-season events. Offseason and preseason events are excluded.</p>
                  {historyLoading ? <p className="mt-3 text-sm text-slate-500">Loading team histories…</p> : historyA && historyB ? <TeamHistoryComparison first={historyA} second={historyB} /> : <p className="mt-3 text-sm text-slate-500">Season histories are unavailable for one or both teams.</p>}
                </div>
                {commonMatches.length > 0 && <div className="mt-2 space-y-1">{commonMatches.map((record) => <a key={record.match.key} href={`https://www.thebluealliance.com/match/${record.match.key}`} target="_blank" rel="noreferrer" className="block rounded-lg bg-slate-50 px-3 py-2 text-xs text-blue-700 hover:bg-blue-50">{record.match.comp_level.toUpperCase()} {record.match.match_number} · {record.match.alliances.red.team_keys.map((key) => key.replace(/^frc/i, "")).join(" / ")} vs {record.match.alliances.blue.team_keys.map((key) => key.replace(/^frc/i, "")).join(" / ")}</a>)}</div>}
              </> : <p className="mt-4 text-sm text-slate-500">Select two different teams to compare their event estimates.</p>}
            </Panel>
            <Panel title="Event team table" description="Percentiles are calculated among teams in this event, using currently available EPA and OPR values."><TeamTable teams={teams} /></Panel>
          </section>}
          {tab === "unexpected" && <section className="space-y-4">
            <Panel title="Which alliances surprised the model?" description="Each bar is one alliance in one match. Positive values mean the alliance scored more than predicted; negative values mean it scored less. Select a row to open that match on The Blue Alliance."><ResidualBars residuals={residuals} /></Panel>
          </section>}
          {tab === "quality" && <Panel title="How well did the model predict this event?" description="Event-specific score error and winner accuracy across available completed matches."><PredictionQuality stats={data.predictionStats} residualStats={data.residualStats} /></Panel>}
          {tab === "alliances" && <Panel title="Repeated alliance combinations" description="Repeated three-team combinations with a notable average score residual. This describes the combination, not individual team contribution."><AlliancePatterns findings={findings.filter((item) => item.category === "alliance-pattern")} /></Panel>}
        </div>
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><p className="text-sm font-semibold text-slate-900">{data.collection.state === "complete" ? "Event analysis complete" : data.collection.state === "partial" ? "Event analysis partially complete" : "Analyzing event matches automatically"}</p><p className="mt-1 text-xs text-slate-500">{data.collection.processedMatchCount} of {data.collection.totalMatchCount} matches processed · {data.collection.unavailableMatchCount} unavailable</p></div>
            <span className="text-sm font-semibold tabular-nums text-slate-700">{data.collection.totalMatchCount ? Math.round(data.collection.processedMatchCount / data.collection.totalMatchCount * 100) : 100}%</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-blue-600 transition-all" style={{width:`${data.collection.totalMatchCount ? data.collection.processedMatchCount / data.collection.totalMatchCount * 100 : 100}%`}} /></div>
          {data.collection.state === "partial" && <p className="mt-2 text-xs text-amber-700">Some Statbotics records were unavailable after retries. Available analytics are still shown.</p>}
        </div>
        <p className="mt-5 text-[11px] leading-5 text-slate-400">Sources: The Blue Alliance supplies event metadata, team rosters, match scores, score breakdowns, and OPR/DPR/CCWM. Statbotics data is supplied by the FieldView Statbotics mirror and includes model predictions and EPA estimates. Event-level model comparisons and alliance residuals are not robot-specific observations.</p>
      </> : null}
    </div>
  );
}
 
function TeamHistoryComparison({first,second}:{first:TeamSeasonHistory;second:TeamSeasonHistory}) {
  return <div className="mt-4 space-y-5">
    <div className="grid gap-4 xl:grid-cols-2">
      <TeamSeasonProfile history={first} accent="blue" />
      <TeamSeasonProfile history={second} accent="teal" />
    </div>
    <div className="rounded-xl border border-slate-200 p-4">
      <h4 className="font-semibold text-slate-900">Season EPA component comparison</h4>
      <p className="mt-1 text-xs text-slate-500">Statbotics modeled contribution estimates. Negative values are below-baseline model estimates, not literal negative points scored.</p>
      <EpaBreakdownComparison first={first} second={second} />
    </div>
  </div>;
}
function TeamSeasonProfile({history,accent}:{history:TeamSeasonHistory;accent:"blue"|"teal"}) {
  const events=history.events.filter((item)=>item.statbotics?.epa?.total_points !== undefined);
  const epaValues=events.map((item)=>item.statbotics?.epa?.total_points ?? 0);
  const firstValue=epaValues[0] ?? null;
  const lastValue=epaValues[epaValues.length-1] ?? null;
  const delta=firstValue !== null && lastValue !== null ? lastValue-firstValue : null;
  const record=history.season?.record?.total;
  const qual=history.season?.record?.qual;
  const ranks=history.season?.ranks ?? {};
  const stats=history.season?.epa?.stats ?? {};
  const color=accent==="blue"?"bg-blue-600":"bg-teal-600";
  const textColor=accent==="blue"?"text-blue-700":"text-teal-700";
  return <section className="min-w-0 rounded-xl bg-slate-50 p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><p className="text-xs font-semibold text-slate-500">Team {history.season?.team ?? history.events[0]?.statbotics?.team ?? ""}</p><h4 className="text-lg font-bold text-slate-950">{history.team.nickname || history.team.name || "Team history"}</h4></div>
      <span className={"text-xs font-bold " + textColor}>{events.length} event snapshots</span>
    </div>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <HistoryMetric label="Season EPA" value={fmt(history.season?.epa?.total_points)} />
      <HistoryMetric label="Overall record" value={record ? `${record.wins ?? 0}-${record.losses ?? 0}-${record.ties ?? 0}` : "—"} />
      <HistoryMetric label="Qual record" value={qual ? `${qual.wins ?? 0}-${qual.losses ?? 0}` : "—"} />
      <HistoryMetric label="EPA change" value={delta === null ? "—" : `${delta > 0 ? "+" : ""}${fmt(delta)}`} />
    </div>
    <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
      {Object.entries(ranks).filter(([,value])=>typeof value==="number").map(([label,value])=><div key={label} className="flex justify-between gap-2 border-b border-slate-200 pb-1"><span className="capitalize text-slate-500">{label} rank</span><span className="font-semibold tabular-nums text-slate-800">{value}</span></div>)}
      {Object.entries(stats).filter(([key,value])=>typeof value==="number" && ["start","pre_elim","mean","max","min"].includes(key)).map(([label,value])=><div key={label} className="flex justify-between gap-2 border-b border-slate-200 pb-1"><span className="capitalize text-slate-500">EPA {label.replace("_"," ")}</span><span className="font-semibold tabular-nums text-slate-800">{fmt(value)}</span></div>)}
    </div>
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between"><h5 className="text-xs font-bold uppercase tracking-wide text-slate-500">EPA by event</h5><span className="text-[11px] text-slate-400">Chronological</span></div>
      <EventEpaBars events={events} color={color} />
    </div>
    <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full min-w-[520px] text-xs">
        <thead className="bg-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-2 py-2">Event</th><th className="px-2 py-2 text-right">EPA</th><th className="px-2 py-2 text-right">Δ EPA</th><th className="px-2 py-2 text-right">Qual W-L</th><th className="px-2 py-2 text-right">RP / match</th><th className="px-2 py-2 text-right">Rank</th></tr></thead>
        <tbody>{history.events.map((item,index)=>{
          const epa=item.statbotics?.epa?.total_points;
          const previous=index>0?history.events[index-1].statbotics?.epa?.total_points:undefined;
          const change=typeof epa==="number"&&typeof previous==="number"?epa-previous:null;
          const qualRecord=item.statbotics?.record?.qual;
          return <tr key={item.event.key} className="border-t border-slate-100">
            <td className="px-2 py-2 font-medium text-slate-700">{item.event.short_name ?? item.event.name}<span className="ml-1 text-[10px] text-slate-400">{item.status==="unavailable"?"· unavailable":""}</span></td>
            <td className="px-2 py-2 text-right tabular-nums">{fmt(epa)}</td>
            <td className={"px-2 py-2 text-right tabular-nums " + (change===null?"text-slate-400":change>=0?"text-emerald-700":"text-rose-700")}>{change===null?"—":(change>0?"+":"")+fmt(change)}</td>
            <td className="px-2 py-2 text-right tabular-nums">{qualRecord?`${qualRecord.wins ?? 0}-${qualRecord.losses ?? 0}`:"—"}</td>
            <td className="px-2 py-2 text-right tabular-nums">{fmt(qualRecord?.rps_per_match,2)}</td>
            <td className="px-2 py-2 text-right tabular-nums">{qualRecord?.rank ?? "—"}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </section>;
}
function HistoryMetric({label,value}:{label:string;value:string}) {
  return <div className="rounded-lg border border-slate-200 bg-white p-2.5"><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 text-lg font-black tabular-nums text-slate-900">{value}</p></div>;
}
function EventEpaBars({events,color}:{events:TeamSeasonHistory["events"];color:string}) {
  const points=events.flatMap((item)=>typeof item.statbotics?.epa?.total_points==="number"?[{label:item.event.short_name ?? item.event.name,value:item.statbotics.epa.total_points}]:[]);
  if(!points.length) return <p className="text-xs text-slate-400">No event EPA snapshots available.</p>;
  const max=Math.max(1,...points.map((point)=>Math.abs(point.value)));
  return <div className="space-y-2">{points.map((point,index)=><div key={index} className="grid grid-cols-[minmax(70px,110px)_1fr_42px] items-center gap-2 text-xs"><span className="truncate text-slate-500" title={point.label}>{point.label}</span><div className="h-3 overflow-hidden rounded-full bg-white"><div className={"h-full rounded-full " + color} style={{width:`${Math.max(2,Math.abs(point.value)/max*100)}%`}} /></div><span className="text-right font-semibold tabular-nums text-slate-700">{fmt(point.value)}</span></div>)}</div>;
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
  return <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead><tr className="border-b text-left text-[11px] uppercase text-slate-400"><th className="py-2">Match</th><th>Alliance</th><th>Teams</th><th>Pre-match EPA</th><th>Predicted</th><th>Actual</th><th>Residual</th></tr></thead><tbody>{records.flatMap((record)=>(["red","blue"] as const).map((color)=>{const alliance=record.match.alliances[color];const predicted=color==="red"?record.statbotics?.pred?.red_score:record.statbotics?.pred?.blue_score;const values=alliance.team_keys.map((key)=>record.statbotics?.pre_epas?.[key.replace(/^frc/i,"")]?.epa);const epa=values.every((value)=>typeof value==="number")?values.reduce<number>((sum,value)=>sum+(value??0),0):null;const actual=typeof alliance.score==="number"&&alliance.score>=0?alliance.score:null;const residual=actual!==null&&typeof predicted==="number"?actual-predicted:null;return <tr key={record.match.key+color} className="border-b border-slate-100"><th className="py-2 text-left">{record.match.comp_level.toUpperCase()} {record.match.match_number}</th><td className="capitalize">{color}</td><td>{alliance.team_keys.map((key)=>key.replace(/^frc/i,"")).join(" · ")}</td><td>{fmt(epa)}</td><td>{fmt(predicted)}</td><td>{fmt(actual)}</td><td className={residual!==null&&residual>=0?"text-emerald-700":"text-rose-700"}>{fmt(residual)}</td></tr>}))}</tbody></table></div>;
}