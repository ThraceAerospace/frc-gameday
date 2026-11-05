"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EventAnalyticsResponse, ReviewFinding, TeamAnalyticsRow } from "@/lib/insights/types";
import type { StatboticsTeamEvent, StatboticsTeamYear } from "@/lib/statbotics/types";

type TeamSeasonHistory = { team: { nickname?: string | null; name?: string | null }; season: StatboticsTeamYear | null; events: { event: { key: string; name: string; start_date: string; week?: number | null }; statbotics: StatboticsTeamEvent | null; status: "ready" | "unavailable" }[] };
type Tab = "review" | "teams" | "unexpected" | "models" | "consistency" | "alliances";
const TABS: { id: Tab; label: string }[] = [
  { id: "review", label: "Review queue" },
  { id: "teams", label: "Team comparison" },
  { id: "unexpected", label: "Unexpected results" },
  { id: "models", label: "Model disagreement" },
  { id: "consistency", label: "Consistency" },
  { id: "alliances", label: "Alliance context" },
];
const fmt = (value: number | null | undefined, digits = 1) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
const percentileLabel = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}th`;

export default function EventAnalyticsDashboard({ eventKey, eventName }: { eventKey: string; eventName: string }) {
  const [data, setData] = useState<EventAnalyticsResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [tab, setTab] = useState<Tab>("review");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [teamA, setTeamA] = useState("");
  const [teamB, setTeamB] = useState("");
  const [historyA, setHistoryA] = useState<TeamSeasonHistory | null>(null);
  const [historyB, setHistoryB] = useState<TeamSeasonHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const load = useCallback(async (nextOffset: number, append: boolean) => {
    append ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/insights/event/${encodeURIComponent(eventKey)}?offset=${nextOffset}&limit=20`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      const next = await response.json() as EventAnalyticsResponse;
      setData((current) => append && current ? {
        ...next,
        matches: [...current.matches, ...next.matches],
        allianceResults: [...current.allianceResults, ...next.allianceResults],
        findings: [...current.findings.filter((item) => !next.findings.some((candidate) => candidate.id === item.id)), ...next.findings],
        loadedMatchCount: current.loadedMatchCount + next.loadedMatchCount,
        hasMore: next.hasMore,
        offset: 0,
      } : next);
      setOffset(nextOffset);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load analytics");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [eventKey]);

  useEffect(() => { void load(0, false); }, [load]);

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
        <nav aria-label="Analytics views" className="no-scrollbar mt-6 flex gap-1 overflow-x-auto border-b border-slate-200">
          {TABS.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`shrink-0 border-b-2 px-3 py-3 text-sm font-semibold ${tab === item.id ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>{item.label}</button>)}
        </nav>
        <div className="mt-5">
          {tab === "review" && <ReviewQueue findings={findings} />}
          {tab === "teams" && <section className="space-y-4">
            <Panel title="Compare teams" description="Compare event-relative model estimates and the alliance outcomes in matches they appeared in.">
              <div className="grid gap-3 sm:grid-cols-2">
                <TeamSelect label="Team A" teams={teams} value={teamA} onChange={setTeamA} />
                <TeamSelect label="Team B" teams={teams} value={teamB} onChange={setTeamB} />
              </div>
              {selectedA && selectedB ? <>
                <div className="mt-5 grid gap-3 md:grid-cols-2"><TeamCard team={selectedA} /><TeamCard team={selectedB} /></div>
                <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[520px] text-sm"><thead><tr className="border-b text-left text-xs uppercase text-slate-400"><th className="py-2">Metric</th><th>Team {selectedA.teamNumber}</th><th>Team {selectedB.teamNumber}</th></tr></thead><tbody>{[
                  ["EPA", selectedA.epa, selectedB.epa], ["Auto EPA", selectedA.autoEpa, selectedB.autoEpa],
                  ["Teleop EPA", selectedA.teleopEpa, selectedB.teleopEpa], ["Endgame EPA", selectedA.endgameEpa, selectedB.endgameEpa],
                  ["OPR", selectedA.opr, selectedB.opr], ["DPR", selectedA.dpr, selectedB.dpr], ["CCWM", selectedA.ccwm, selectedB.ccwm],
                  ["EPA percentile", selectedA.epaPercentile === null ? null : selectedA.epaPercentile * 100, selectedB.epaPercentile === null ? null : selectedB.epaPercentile * 100],
                  ["OPR percentile", selectedA.oprPercentile === null ? null : selectedA.oprPercentile * 100, selectedB.oprPercentile === null ? null : selectedB.oprPercentile * 100],
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
            <Panel title="Predicted vs actual alliance score" description="Each point is one alliance score. Points above the diagonal exceeded prediction; points below fell short."><ResidualPlot residuals={residuals} /></Panel>
            <Panel title="Largest score residuals" description="Actual minus predicted score. These are alliance outcomes, not individual team contributions."><div className="space-y-2">{[...residuals].sort((a,b)=>Math.abs(b.residual ?? 0)-Math.abs(a.residual ?? 0)).slice(0,20).map((item)=><div key={item.matchKey+item.color} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm"><div><strong>{item.matchLabel}</strong><span className="ml-2 text-xs capitalize text-slate-500">{item.color} alliance</span><p className="text-xs text-slate-500">Teams {item.teamKeys.map((key)=>key.replace(/^frc/i,"")).join(" · ")}</p></div><strong className={item.residual! >= 0 ? "text-emerald-700" : "text-rose-700"}>{item.residual! > 0 ? "+" : ""}{fmt(item.residual)} pts</strong></div>)}</div></Panel>
          </section>}
          {tab === "models" && <Panel title="EPA vs OPR disagreement" description="Both metrics are converted to within-event percentiles before comparison. Percentiles show relative position, not interchangeable point units."><ModelScatter teams={teams} /></Panel>}
          {tab === "consistency" && <section className="space-y-4">
            <Panel title="Team-level alliance outcome context" description="Residual mean and spread summarize alliance scores in matches featuring each team. They do not isolate the team's contribution."><TeamTable teams={[...teams].sort((a,b)=>(b.allianceResidualSpread ?? -1)-(a.allianceResidualSpread ?? -1))} showResidual /></Panel>
            <Panel title="Match-by-match EPA changes" description="The chart shows model rating updates, not observed robot performance."><EpaChangeChart records={data.matches} teams={teams} /></Panel>
          </section>}
          {tab === "alliances" && <Panel title="Alliance context" description="Inspect alliance partners, opponents, pre-match EPA totals, predictions, and actual scores."><AllianceTable records={data.matches} /></Panel>}
        </div>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
          <p className="text-xs text-slate-500">Loaded {data.loadedMatchCount} of {data.matchCount} matches. Each page loads up to 20 Statbotics match records.</p>
          <div className="flex gap-2"><button disabled={offset === 0 || loadingMore} onClick={() => void load(Math.max(0, offset-20), false)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm disabled:opacity-40">Previous page</button><button disabled={!data.hasMore || loadingMore} onClick={() => void load(offset+20, true)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">{loadingMore ? "Loading…" : "Load next 20 matches"}</button></div>
        </div>
      </> : null}
    </div>
  );
}
 
function TeamHistoryComparison({first,second}:{first:TeamSeasonHistory;second:TeamSeasonHistory}) {
  const firstPoints=first.events.flatMap((item)=>typeof item.statbotics?.epa?.total_points==="number"?[{label:item.event.short_name ?? item.event.name,value:item.statbotics.epa.total_points}]:[]);
  const secondPoints=second.events.flatMap((item)=>typeof item.statbotics?.epa?.total_points==="number"?[{label:item.event.short_name ?? item.event.name,value:item.statbotics.epa.total_points}]:[]);
  const all=[...firstPoints,...secondPoints];
  const max=Math.max(1,...all.map((point)=>point.value));
  return <div className="mt-3 grid gap-4 lg:grid-cols-2">
    <div><p className="text-xs font-semibold text-slate-700">Team {first.team.nickname || first.team.name}</p><HistoryLine points={firstPoints} max={max} color="#2563eb"/><p className="mt-1 text-xs text-slate-500">Team-year EPA: {fmt(first.season?.epa?.total_points)}</p><HistoryTable events={first.events}/></div>
    <div><p className="text-xs font-semibold text-slate-700">Team {second.team.nickname || second.team.name}</p><HistoryLine points={secondPoints} max={max} color="#0f766e"/><p className="mt-1 text-xs text-slate-500">Team-year EPA: {fmt(second.season?.epa?.total_points)}</p><HistoryTable events={second.events}/></div>
  </div>;
}
function HistoryLine({points,max,color}:{points:{label:string;value:number}[];max:number;color:string}) {
  if (!points.length) return <p className="py-5 text-xs text-slate-400">No Statbotics team-event history available.</p>;
  const width=280, height=100, pad=12;
  const coords=points.map((point,index)=>({x:pad+(points.length===1?0:index/(points.length-1))*(width-pad*2),y:height-pad-(point.value/max)*(height-pad*2)}));
  return <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 w-full max-w-sm" role="img" aria-label="Team EPA progression by event"><line x1={pad} y1={height-pad} x2={width-pad} y2={height-pad} stroke="#cbd5e1"/><polyline points={coords.map((point)=>`${point.x},${point.y}`).join(" ")} fill="none" stroke={color} strokeWidth="2.5"/>{coords.map((point,index)=><circle key={index} cx={point.x} cy={point.y} r="3.5" fill={color}><title>{points[index].label}: {points[index].value.toFixed(1)} EPA</title></circle>)}</svg>;
}
function HistoryTable({events}:{events:TeamSeasonHistory["events"]}) {
  return <div className="mt-2 max-h-48 overflow-auto rounded-lg border border-slate-100"><table className="w-full text-xs"><thead className="sticky top-0 bg-slate-50 text-left text-slate-400"><tr><th className="px-2 py-1.5">Event</th><th className="px-2 py-1.5 text-right">EPA</th><th className="px-2 py-1.5 text-right">Qual W-L</th></tr></thead><tbody>{events.map((item)=><tr key={item.event.key} className="border-t border-slate-100"><td className="px-2 py-1.5">{item.event.short_name ?? item.event.name}</td><td className="px-2 py-1.5 text-right tabular-nums">{fmt(item.statbotics?.epa?.total_points)}</td><td className="px-2 py-1.5 text-right tabular-nums">{item.statbotics?.record?.qual ? `${item.statbotics.record.qual.wins ?? "—"}-${item.statbotics.record.qual.losses ?? "—"}` : "—"}</td></tr>)}</tbody></table></div>;
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
  return <div className="rounded-xl bg-slate-50 p-4"><div className="text-xs text-slate-500">Team {team.teamNumber}</div><div className="mt-1 text-xl font-bold text-slate-900">{team.name}</div><div className="mt-3 grid grid-cols-2 gap-3"><div><div className="text-xs text-slate-500">EPA</div><div className="text-2xl font-black tabular-nums">{fmt(team.epa)}</div></div><div><div className="text-xs text-slate-500">OPR percentile</div><div className="text-2xl font-black tabular-nums">{percentileLabel(team.oprPercentile)}</div></div></div><div className="mt-2 text-xs text-slate-500">{team.matchesSeen} loaded matches · EPA percentile {percentileLabel(team.epaPercentile)}</div></div>;
}
function TeamTable({teams,showResidual=false}:{teams:TeamAnalyticsRow[];showResidual?:boolean}) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm"><thead><tr className="border-b text-left text-[11px] uppercase text-slate-400"><th className="py-2">Team</th><th>EPA</th><th>OPR</th><th>DPR</th><th>CCWM</th><th>EPA %ile</th>{showResidual && <><th>Alliance residual avg</th><th>Spread</th></>}</tr></thead><tbody>{teams.map((team)=><tr key={team.teamKey} className="border-b border-slate-100"><th className="py-2 text-left"><Link className="font-semibold text-slate-800 hover:text-blue-700" href={`/team/${team.teamNumber}`}>{team.teamNumber} · {team.name}</Link></th><td>{fmt(team.epa)}</td><td>{fmt(team.opr)}</td><td>{fmt(team.dpr)}</td><td>{fmt(team.ccwm)}</td><td>{percentileLabel(team.epaPercentile)}</td>{showResidual && <><td>{fmt(team.allianceResidualMean)}</td><td>{fmt(team.allianceResidualSpread)}</td></>}</tr>)}</tbody></table></div>;
}
function ReviewQueue({findings}:{findings:ReviewFinding[]}) {
  const [reviewed,setReviewed] = useState<string[]>([]);
  const [dismissed,setDismissed] = useState<string[]>([]);
  const visible = findings.filter((finding)=>!dismissed.includes(finding.id));
  return <Panel title="Scouting review queue" description="Rule-based signals from the currently loaded match sample. Review state is local to this browser in this prototype.">
    <div className="mb-3 flex flex-wrap gap-3 text-xs text-slate-500"><span>{visible.length} findings</span><span>{reviewed.length} reviewed</span><span>{dismissed.length} dismissed</span></div>
    {!visible.length ? <p className="text-sm text-slate-500">No findings met the current prototype thresholds in this sample.</p> : <div className="space-y-3">{visible.map((finding)=><article key={finding.id} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${finding.severity==="high"?"bg-rose-100 text-rose-700":finding.severity==="medium"?"bg-amber-100 text-amber-800":"bg-slate-100 text-slate-600"}`}>{finding.severity}</span><span className="text-xs text-slate-400">{finding.category} · {finding.sampleCoverage} sample coverage · n={finding.sampleSize}</span></div><p className="mt-2 text-xs font-semibold text-slate-500">{finding.subject}</p><h3 className="mt-1 font-bold text-slate-900">{finding.title}</h3><p className="mt-1 text-sm text-slate-600">{finding.description}</p><ul className="mt-2 list-disc pl-5 text-xs text-slate-500">{finding.evidence.map((item)=><li key={item}>{item}</li>)}</ul><p className="mt-2 text-xs font-medium text-slate-700">Suggested follow-up: {finding.suggestedAction}</p><div className="mt-3 flex gap-2"><button onClick={()=>setReviewed((current)=>current.includes(finding.id)?current:[...current,finding.id])} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold">{reviewed.includes(finding.id)?"Reviewed":"Mark reviewed"}</button><button onClick={()=>setDismissed((current)=>[...current,finding.id])} className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100">Dismiss</button></div></article>)}</div>}
  </Panel>;
}
function ResidualPlot({residuals}:{residuals:{matchKey:string;matchLabel:string;color:string;predicted:number|null;actual:number|null;residual:number|null}[]}) {
  const points=residuals.filter((item)=>item.predicted!==null&&item.actual!==null);
  if (!points.length) return <p className="text-sm text-slate-500">No completed matches with predictions are available in this sample.</p>;
  const max=Math.max(1,...points.flatMap((item)=>[item.predicted??0,item.actual??0]))*1.05;
  const xy=(value:number)=>40+(value/max)*520;
  return <div className="overflow-x-auto"><svg viewBox="0 0 600 430" className="w-full min-w-[420px]" role="img" aria-label="Predicted versus actual alliance score scatter plot"><line x1="40" y1="390" x2="560" y2="390" stroke="#94a3b8"/><line x1="40" y1="390" x2="40" y2="30" stroke="#94a3b8"/><line x1="40" y1="390" x2="560" y2="30" stroke="#cbd5e1" strokeDasharray="5 5"/>{points.map((item)=><circle key={item.matchKey+item.color} cx={xy(item.predicted!)} cy={390-(item.actual!/max)*360} r="4" fill={item.color==="red"?"#dc2626":"#2563eb"} opacity=".75"><title>{item.matchLabel} {item.color}: predicted {item.predicted}, actual {item.actual}, residual {item.residual}</title></circle>)}<text x="300" y="423" textAnchor="middle" fontSize="12" fill="currentColor">Predicted alliance score</text><text x="12" y="210" transform="rotate(-90 12 210)" textAnchor="middle" fontSize="12" fill="currentColor">Actual alliance score</text></svg><div className="mt-2 flex gap-4 text-xs text-slate-500"><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-red-600"/>Red alliance</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-600"/>Blue alliance</span></div></div>;
}
function ModelScatter({teams}:{teams:TeamAnalyticsRow[]}) {
  const rows=teams.filter((team)=>team.epaPercentile!==null&&team.oprPercentile!==null);
  if (!rows.length) return <p className="text-sm text-slate-500">EPA and OPR data are not yet available.</p>;
  return <div className="overflow-x-auto"><svg viewBox="0 0 600 430" className="w-full min-w-[420px]" role="img" aria-label="EPA percentile versus OPR percentile"><line x1="45" y1="380" x2="560" y2="380" stroke="#94a3b8"/><line x1="45" y1="380" x2="45" y2="30" stroke="#94a3b8"/><line x1="45" y1="380" x2="560" y2="30" stroke="#e2e8f0" strokeDasharray="5 5"/>{rows.map((team)=><circle key={team.teamKey} cx={45+(team.epaPercentile??0)*515} cy={380-(team.oprPercentile??0)*350} r="5" fill="#2563eb" opacity=".75"><title>Team {team.teamNumber}: EPA {percentileLabel(team.epaPercentile)}, OPR {percentileLabel(team.oprPercentile)}</title></circle>)}<text x="300" y="415" textAnchor="middle" fontSize="12" fill="currentColor">EPA percentile</text><text x="12" y="205" transform="rotate(-90 12 205)" textAnchor="middle" fontSize="12" fill="currentColor">OPR percentile</text></svg><p className="mt-2 text-xs text-slate-500">Teams far from the diagonal have greater model disagreement. This compares event-relative rank only.</p></div>;
}
function EpaChangeChart({records,teams}:{records:EventAnalyticsResponse["matches"];teams:TeamAnalyticsRow[]}) {
  const [selected,setSelected]=useState("");
  const points=records.filter((record)=>[...record.match.alliances.red.team_keys,...record.match.alliances.blue.team_keys].some((key)=>key.replace(/^frc/i,"")===selected)).map((record)=>{
    const before=record.statbotics?.pre_epas?.[selected]?.epa;
    const after=record.statbotics?.epas?.[selected]?.epa;
    return typeof before==="number"&&typeof after==="number"?{label:record.match.comp_level==="qm"?`QM ${record.match.match_number}`:`${record.match.comp_level.toUpperCase()} ${record.match.match_number}`,delta:after-before}:null;
  }).filter((point):point is {label:string;delta:number}=>point!==null);
  const max=Math.max(1,...points.map((point)=>Math.abs(point.delta)));
  return <><label className="block max-w-xs text-sm font-semibold text-slate-700">Team<select value={selected} onChange={(event)=>setSelected(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2"><option value="">Choose team</option>{teams.map((item)=><option key={item.teamKey} value={item.teamNumber}>{item.teamNumber} · {item.name}</option>)}</select></label>{selected && points.length === 0 && <p className="mt-3 text-sm text-slate-500">No match-level EPA updates for this team are loaded yet. Load more matches or choose another team.</p>}{selected && <div className="mt-3 space-y-2">{points.map((point,index)=><div key={index} className="grid grid-cols-[70px_1fr_65px] items-center gap-2 text-xs"><span className="text-slate-500">{point.label}</span><div className="h-3 overflow-hidden rounded bg-slate-100"><div className={`h-full ${point.delta>=0?"bg-emerald-500":"bg-rose-500"}`} style={{width:`${Math.abs(point.delta)/max*100}%`}}/></div><span className="text-right tabular-nums">{point.delta>0?"+":""}{fmt(point.delta)}</span></div>)}</div>}</>;
}
function AllianceTable({records}:{records:EventAnalyticsResponse["matches"]}) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead><tr className="border-b text-left text-[11px] uppercase text-slate-400"><th className="py-2">Match</th><th>Alliance</th><th>Teams</th><th>Pre-match EPA</th><th>Predicted</th><th>Actual</th><th>Residual</th></tr></thead><tbody>{records.flatMap((record)=>(["red","blue"] as const).map((color)=>{const alliance=record.match.alliances[color];const predicted=color==="red"?record.statbotics?.pred?.red_score:record.statbotics?.pred?.blue_score;const values=alliance.team_keys.map((key)=>record.statbotics?.pre_epas?.[key.replace(/^frc/i,"")]?.epa);const epa=values.every((value)=>typeof value==="number")?values.reduce<number>((sum,value)=>sum+(value??0),0):null;const actual=typeof alliance.score==="number"&&alliance.score>=0?alliance.score:null;const residual=actual!==null&&typeof predicted==="number"?actual-predicted:null;return <tr key={record.match.key+color} className="border-b border-slate-100"><th className="py-2 text-left">{record.match.comp_level.toUpperCase()} {record.match.match_number}</th><td className="capitalize">{color}</td><td>{alliance.team_keys.map((key)=>key.replace(/^frc/i,"")).join(" · ")}</td><td>{fmt(epa)}</td><td>{fmt(predicted)}</td><td>{fmt(actual)}</td><td className={residual!==null&&residual>=0?"text-emerald-700":"text-rose-700"}>{fmt(residual)}</td></tr>}))}</tbody></table></div>;
}
