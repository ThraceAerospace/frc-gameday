import Link from "next/link";
import SiteShell from "@/components/navigation/SiteShell";
import { TBA } from "@/lib/tba/service";

export default async function DistrictsPage() {
  const year = new Date().getFullYear();
  const [events, districts] = await Promise.all([
    TBA.getEvents(year),
    TBA.getDistricts(year),
  ]);

  const summaries = await Promise.all(districts.map(async (district) => {
    try {
      const [teams, districtEvents, rankings] = await Promise.all([
        TBA.getDistrictTeams(district.key),
        TBA.getDistrictEvents(district.key),
        TBA.getDistrictRankings(district.key),
      ]);
      return { ...district, teamsCount: teams.length, events: districtEvents, rankings };
    } catch {
      return { ...district, teamsCount: 0, events: [], rankings: [] };
    }
  }));

  return (
    <SiteShell events={events}>
      <div className="mx-auto max-w-6xl px-5 py-8 lg:px-8">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">FIRST Robotics Competition</p>
        <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">{year} Districts</h1>
        <p className="mt-2 text-sm text-slate-500">Explore district events, team counts, and point rankings.</p>
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {summaries.map((district) => (
            <section key={district.key} className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-100 p-5">
                <p className="font-mono text-xs text-slate-400">{district.key}</p>
                <h2 className="mt-1 truncate text-lg font-bold text-slate-900">{district.display_name}</h2>
                <div className="mt-3 flex gap-4 text-xs text-slate-500">
                  <span>{district.teamsCount} teams</span><span>{district.events.length} events</span><span>{district.rankings.length} ranked</span>
                </div>
              </div>
              <div className="p-4">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Events</p>
                <div className="space-y-1">
                  {district.events.slice(0, 4).map((event) => <Link key={event.key} href={`/event/${event.key}`} className="block truncate rounded-lg px-2 py-2 text-sm text-slate-700 hover:bg-blue-50 hover:text-blue-700">{event.name}</Link>)}
                </div>
                <p className="mb-2 mt-4 text-[11px] font-bold uppercase tracking-wider text-slate-400">Top district points</p>
                <div className="space-y-1">
                  {district.rankings.slice(0, 5).map((ranking: any, index: number) => <div key={ranking.team_key ?? index} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-2 py-2 text-xs"><span className="truncate font-mono text-slate-700">{ranking.team_key?.replace(/^frc/, "") ?? "—"}</span><span className="shrink-0 font-semibold text-slate-900">{ranking.point_total ?? ranking.total_points ?? "—"} pts</span></div>)}
                </div>
              </div>
            </section>
          ))}
        </div>
      </div>
    </SiteShell>
  );
}
