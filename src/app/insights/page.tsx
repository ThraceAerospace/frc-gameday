import Link from "next/link";
import SiteShell from "@/components/navigation/SiteShell";
import { TBA } from "@/lib/tba/service";

export default async function InsightsPage() {
  const year = new Date().getFullYear();
  const [events, teams] = await Promise.all([TBA.getEvents(year), TBA.getTeams(year)]);
  const eventCounts = new Map<string, number>();
  const districtCounts = new Map<string, number>();
  for (const event of events) {
    const type = event.event_type_string ?? String(event.event_type);
    eventCounts.set(type, (eventCounts.get(type) ?? 0) + 1);
    if (event.district?.display_name) districtCounts.set(event.district.display_name, (districtCounts.get(event.district.display_name) ?? 0) + 1);
  }
  const byType = [...eventCounts.entries()].sort((a,b) => b[1]-a[1]);
  const byDistrict = [...districtCounts.entries()].sort((a,b) => b[1]-a[1]);
  const maxType = Math.max(1, ...byType.map(([,n])=>n));
  const maxDistrict = Math.max(1, ...byDistrict.map(([,n])=>n));

  return (
    <SiteShell events={events}>
      <div className="mx-auto max-w-6xl px-5 py-8 lg:px-8">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">Data Explorer</p>
        <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">FIRST Insights</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">A season-wide overview of event distribution and team participation. This is the starting point for FieldView's deeper statistical comparisons across events, teams, and districts.</p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Season" value={year} detail="Current season" />
          <Metric label="Events" value={events.length} detail="TBA event records" />
          <Metric label="Teams" value={teams.length} detail="Teams with season records" />
          <Metric label="Districts" value={districtCounts.size} detail="Represented in event data" />
        </div>

        <div className="mt-6 grid min-w-0 gap-5 xl:grid-cols-2">
          <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-bold text-slate-900">Events by type</h2>
            <div className="mt-5 space-y-4">{byType.map(([name,count])=><div key={name}><div className="mb-1 flex justify-between gap-3 text-sm"><span className="truncate text-slate-700">{name}</span><span className="shrink-0 font-semibold tabular-nums text-slate-900">{count}</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-blue-600" style={{width:`${count/maxType*100}%`}} /></div></div>)}</div>
          </section>
          <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-bold text-slate-900">Events by district</h2>
            <div className="mt-5 space-y-4">{byDistrict.map(([name,count])=><div key={name}><div className="mb-1 flex justify-between gap-3 text-sm"><span className="truncate text-slate-700">{name}</span><span className="shrink-0 font-semibold tabular-nums text-slate-900">{count}</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-500" style={{width:`${count/maxDistrict*100}%`}} /></div></div>)}</div>
          </section>
        </div>

        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-bold text-slate-900">Next statistical layers</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <InsightLink href="/events" title="Event comparisons" detail="Compare event sizes, schedules, and competitive depth." />
            <InsightLink href="/teams" title="Team performance" detail="Connect season records, event results, and team-level metrics." />
            <InsightLink href="/districts" title="District performance" detail="Explore district rankings and advancement." />
          </div>
        </section>
      </div>
    </SiteShell>
  );
}

function Metric({label,value,detail}:{label:string;value:string|number;detail:string}) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</p><p className="mt-2 text-3xl font-black tabular-nums text-slate-950">{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>;
}
function InsightLink({href,title,detail}:{href:string;title:string;detail:string}) {
  return <Link href={href} className="rounded-xl bg-slate-50 p-4 hover:bg-blue-50"><p className="font-semibold text-slate-900">{title}</p><p className="mt-1 text-sm leading-5 text-slate-500">{detail}</p></Link>;
}
