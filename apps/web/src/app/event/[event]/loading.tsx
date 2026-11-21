import SiteShell from "@/components/navigation/SiteShell";

export default function EventLoading() {
  return (
    <SiteShell>
      <main className="mx-auto min-h-full max-w-6xl space-y-5 px-4 py-8 sm:px-6" aria-label="Loading event">
        <div className="animate-pulse rounded-2xl border border-[var(--fv-border)] bg-[var(--fv-surface-card)] p-6 sm:p-8">
          <div className="h-3 w-36 rounded bg-slate-300/70" />
          <div className="mt-4 h-8 w-2/3 rounded bg-slate-300/70" />
          <div className="mt-3 h-4 w-1/2 rounded bg-slate-300/70" />
          <div className="mt-7 flex gap-5 border-t border-[var(--fv-border)] pt-5">
            <div className="h-4 w-20 rounded bg-slate-300/70" />
            <div className="h-4 w-20 rounded bg-slate-300/70" />
            <div className="h-4 w-20 rounded bg-slate-300/70" />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="h-36 rounded-2xl border border-[var(--fv-border)] bg-[var(--fv-surface-card)] p-5 animate-pulse">
              <div className="h-4 w-1/3 rounded bg-slate-300/70" />
              <div className="mt-5 h-3 w-full rounded bg-slate-300/70" />
              <div className="mt-3 h-3 w-4/5 rounded bg-slate-300/70" />
            </div>
          ))}
        </div>
      </main>
    </SiteShell>
  );
}
