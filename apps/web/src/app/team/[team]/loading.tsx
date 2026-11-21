import SiteShell from "@/components/navigation/SiteShell";

export default function TeamLoading() {
  return (
    <SiteShell>
      <main className="mx-auto min-h-full max-w-7xl space-y-5 px-4 py-8 sm:px-6" aria-label="Loading team profile">
        <div className="animate-pulse rounded-2xl border border-[var(--fv-border)] bg-[var(--fv-surface-card)] p-6 sm:p-8">
          <div className="h-3 w-28 rounded bg-slate-300/70" />
          <div className="mt-4 h-8 w-1/2 rounded bg-slate-300/70" />
          <div className="mt-3 h-4 w-2/5 rounded bg-slate-300/70" />
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="h-20 rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-card)] animate-pulse" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="h-64 rounded-2xl border border-[var(--fv-border)] bg-[var(--fv-surface-card)] animate-pulse" />
          <div className="space-y-4">
            {[0, 1, 2].map((item) => (
              <div key={item} className="h-40 rounded-2xl border border-[var(--fv-border)] bg-[var(--fv-surface-card)] animate-pulse" />
            ))}
          </div>
        </div>
      </main>
    </SiteShell>
  );
}
