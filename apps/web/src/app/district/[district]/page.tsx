import Link from "next/link";
import SiteShell from "@/components/navigation/SiteShell";
import { formatTeamNumber } from "@/lib/tba/formatters";
import { TBA } from "@/lib/tba/service";

export const revalidate = 3600;
export const dynamicParams = false;

export async function generateStaticParams() {
  const districts = await TBA.getDistricts(new Date().getFullYear());
  return districts.map((district) => ({ district: district.abbreviation.toLowerCase() }));
}

export default async function DistrictPage({ params }: { params: Promise<{ district: string }> }) {
  const { district: requestedKey } = await params;
  const year = new Date().getFullYear();
  const districts = await TBA.getDistricts(year);
  const district = districts.find((item) => item.abbreviation.toLowerCase() === requestedKey.toLowerCase() || item.key.toLowerCase() === requestedKey.toLowerCase());

  if (!district) {
    return <SiteShell><div className="mx-auto max-w-5xl px-5 py-12"><h1 className="text-2xl font-bold text-slate-900">District unavailable</h1><p className="mt-2 text-sm text-slate-500">No active {year} district matches this key.</p><Link href="/districts" className="mt-5 inline-block text-sm font-semibold text-[var(--fv-brand)]">← All districts</Link></div></SiteShell>;
  }

  const [teams, events, rankings] = await Promise.all([
    TBA.getDistrictTeams(district.key),
    TBA.getDistrictEvents(district.key),
    TBA.getDistrictRankings(district.key),
  ]);

  return (
    <SiteShell>
      <div className="mx-auto max-w-6xl px-5 py-8 lg:px-8 lg:py-10">
        <Link href="/districts" className="text-sm font-semibold text-[var(--fv-brand)] hover:text-[var(--fv-brand)]">← {year} Districts</Link>
        <header className="mt-4 border-b border-slate-200 pb-6">
          <p className="font-mono text-xs text-slate-400">{district.key}</p>
          <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">{district.display_name}</h1>
          <p className="mt-2 text-sm text-slate-500">{teams.length} teams · {events.length} events · {rankings.length} ranked teams</p>
        </header>
        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
          <section className="min-w-0">
            <h2 className="mb-3 text-lg font-bold text-slate-900">Events</h2>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              {events.map((event, index) => <Link key={event.key} href={`/event/${event.key}`} className={`block px-4 py-3 hover:bg-[var(--fv-brand-soft)]/50 ${index ? "border-t border-slate-100" : ""}`}><p className="font-semibold text-slate-900">{event.name}</p><p className="mt-1 text-xs text-slate-500">{event.city}{event.state_prov ? `, ${event.state_prov}` : ""} · {event.start_date} – {event.end_date}</p></Link>)}
              {!events.length && <p className="p-4 text-sm text-slate-500">No district events are listed.</p>}
            </div>
          </section>
          <section className="min-w-0">
            <h2 className="mb-3 text-lg font-bold text-slate-900">District rankings</h2>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              {rankings.map((ranking, index) => <div key={ranking.team_key ?? index} className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5 last:border-0"><Link href={`/team/${ranking.team_key}?year=${year}`} className="font-mono text-sm font-semibold text-slate-800 hover:text-[var(--fv-brand)]">{ranking.team_key ? formatTeamNumber(ranking.team_key) : "—"}</Link><span className="text-sm font-semibold tabular-nums text-slate-600">{ranking.point_total ?? "—"} pts</span></div>)}
              {!rankings.length && <p className="p-4 text-sm text-slate-500">No rankings are available yet.</p>}
            </div>
          </section>
        </div>
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-bold text-slate-900">Teams ({teams.length})</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {teams.map((team) => <Link key={team.key} href={`/team/${team.team_number}?year=${year}`} className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 hover:border-[var(--fv-brand-border)] hover:bg-[var(--fv-brand-soft)]/40"><span className="font-mono text-sm font-bold text-slate-900">{team.team_number}</span><span className="ml-2 truncate text-sm text-slate-600">{team.nickname || team.name || "Team"}</span></Link>)}
          </div>
        </section>
      </div>
    </SiteShell>
  );
}
