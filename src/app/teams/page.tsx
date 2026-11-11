import Link from "next/link";
import { TBA } from "@/lib/tba/service";
import SiteShell from "@/components/navigation/SiteShell";
import PageContainer from "@/components/ui/PageContainer";
import PageHeader from "@/components/ui/PageHeader";
import SurfaceCard from "@/components/ui/SurfaceCard";
import { formatTeamNumber } from "@/lib/tba/formatters";

export default async function TeamsPage() {
  const year = new Date().getFullYear();
  const teams = await TBA.getTeams(year);

  return (
    <SiteShell>
      <PageContainer>
        <PageHeader eyebrow="Teams" title={`${year} teams`} description="Browse teams listed for the current season, then open a team page." />

        {teams.length === 0 ? (
          <SurfaceCard className="mt-6 border-dashed p-8 text-center">
            <p className="font-semibold text-slate-800">No teams were returned for {year}.</p>
            <p className="mt-1 text-sm text-slate-500">The Blue Alliance may not have published this season's team directory yet.</p>
          </SurfaceCard>
        ) : (
        <div className="mt-6 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {teams.slice(0, 200).map((team) => (
            <Link
              key={team.key}
              href={`/team/${team.key}`}
              className="min-w-0 rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] p-4 shadow-sm transition-colors hover:border-[var(--fv-brand-border)] hover:bg-[var(--fv-brand-soft)]/40"
            >
              <p className="font-mono text-lg font-bold text-slate-900">
                {formatTeamNumber(team.key)}
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

        )}
        {teams.length > 200 && (
          <p className="mt-6 text-center text-xs text-slate-400">
            Showing the first 200 teams. Team search will be expanded in the
            next navigation pass.
          </p>
        )}
      </PageContainer>
    </SiteShell>
  );
}
