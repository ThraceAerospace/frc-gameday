import { Suspense } from "react";
import Link from "next/link";
import { CalendarDaysIcon } from "@heroicons/react/24/outline";
import SiteShell from "@/components/navigation/SiteShell";
import HomeEventCard from "@/components/event/HomeEventCard";
import PendingSnapshotRefresh from "@/components/runtime/PendingSnapshotRefresh";
import { getCanonicalEventThisWeek } from "@/lib/events/serverSnapshot";
import { getEventCompetitionStatus } from "@/lib/time";

export const revalidate = 300;

async function ThisWeekEvents() {
  const projection = await getCanonicalEventThisWeek();
  const now = new Date();
  const events = [...(projection?.events ?? [])].sort((a, b) =>
    ({ inProgress: 0, upcoming: 1, completed: 2 } as const)[getEventCompetitionStatus(
      a.start_date, a.end_date, a.timezone, now,
    )] - ({ inProgress: 0, upcoming: 1, completed: 2 } as const)[getEventCompetitionStatus(
      b.start_date, b.end_date, b.timezone, now,
    )]
    || a.start_date.localeCompare(b.start_date)
    || a.name.localeCompare(b.name),
  );

  return (
    <section className="mt-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[var(--fv-brand)]">
            <CalendarDaysIcon className="h-5 w-5" />
            <span className="text-xs font-bold uppercase tracking-[0.16em]">Events this week</span>
          </div>
          <h2 className="mt-1 text-2xl font-bold text-slate-900">
            {projection?.pending ? "Events are loading" : `${events.length} ${events.length === 1 ? "event" : "events"}`}
          </h2>
        </div>
        <Link href="/events" className="hidden text-sm font-semibold text-[var(--fv-brand)] hover:text-[var(--fv-brand-strong)] sm:block">Browse all events →</Link>
      </div>

      {events.length ? (
        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          {events.map((event) => (
            <HomeEventCard key={event.key} event={event} lastMatch={null} nextMatch={null} enrichmentPending />
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500" aria-live="polite">
          {projection?.pending ? "Preparing this week's event list…" : projection ? "There are no events scheduled for this week." : "The weekly event list is temporarily unavailable."}
        </div>
      )}
      {projection?.pending ? <PendingSnapshotRefresh /> : null}
      <Link href="/events" className="mt-4 block text-center text-sm font-semibold text-[var(--fv-brand)] sm:hidden">Browse all events →</Link>
    </section>
  );
}

function ThisWeekFallback() {
  return (
    <section className="mt-8" aria-label="Loading this week's events">
      <div className="h-7 w-48 animate-pulse rounded bg-slate-300/70" />
      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        {[0, 1].map((item) => (
          <div key={item} className="h-40 animate-pulse rounded-2xl border border-slate-200 bg-white p-5">
            <div className="h-4 w-1/3 rounded bg-slate-300/70" />
            <div className="mt-5 h-3 w-full rounded bg-slate-300/70" />
            <div className="mt-3 h-3 w-4/5 rounded bg-slate-300/70" />
          </div>
        ))}
      </div>
    </section>
  );
}

export default function HomePage() {
  return (
    <SiteShell>
      <div className="mx-auto max-w-6xl px-5 py-8 lg:px-8 lg:py-10">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--fv-brand)]">FIRST Robotics Competition</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">This week in FIRST</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500">
            Browse events, teams, matches, and live Gameday views. FieldView starts with The Blue Alliance data and builds richer live-event tools on top of it.
          </p>
        </section>

        <Suspense fallback={<ThisWeekFallback />}>
          <ThisWeekEvents />
        </Suspense>
      </div>
    </SiteShell>
  );
}
