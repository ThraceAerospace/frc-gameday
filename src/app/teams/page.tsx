import Link from "next/link";
import { TBA } from "@/lib/tba/service";
import SiteShell from "@/components/navigation/SiteShell";

export default async function TeamsPage() {
  const year = new Date().getFullYear();
  const [events, teams] = await Promise.all([
    TBA.getEvents(year),
    TBA.getTeams(year),
  ]);

  return (
    <SiteShell events={events}>
      <div className="mx-auto max-w-6xl px-5 py-8 lg:px-8 lg:py-10">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">
          Teams
        </p>
        <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">
          {year} teams
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          Search for a team using the navigation search, then open its team
          page.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {teams.slice(0, 200).map((team) => (
            <Link
              key={team.key}
              href={`/team/${team.key}`}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-blue-200 hover:bg-blue-50/40"
            >
              <p className="font-mono text-lg font-bold text-slate-900">
                {team.key.replace(/^frc/, "")}
              </p>
              <p className="mt-1 truncate text-sm font-semibold text-slate-700">
                {team.nickname || team.name || "Team"}
              </p>
              <p className="mt-1 truncate text-xs text-slate-400">
                {team.city}
                {team.state_prov ? `, ${team.state_prov}` : ""}
              </p>
            </Link>
          ))}
        </div>

        {teams.length > 200 && (
          <p className="mt-6 text-center text-xs text-slate-400">
            Showing the first 200 teams. Team search will be expanded in the
            next navigation pass.
          </p>
        )}
      </div>
    </SiteShell>
  );
}
