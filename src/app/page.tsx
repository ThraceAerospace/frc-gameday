import Link from "next/link";
import { unstable_cache } from "next/cache";
import { CalendarDaysIcon } from "@heroicons/react/24/outline";
import SiteShell from "@/components/navigation/SiteShell";
import HomeEventCard from "@/components/event/HomeEventCard";
import { TBA } from "@/lib/tba/service";
import { getLastMatch, getNextMatch, sortMatches } from "@/lib/tba/matchUtils";
import type { TBAEvent } from "@/lib/tba/types";
import { getEventCompetitionStatus, parseLocalDate } from "@/lib/time";

export const revalidate = 3600;

function getCalendarWeekEvents(events: TBAEvent[], now = new Date()) {
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  return events
    .filter((event) => parseLocalDate(event.start_date) <= weekEnd && parseLocalDate(event.end_date) >= weekStart)
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.name.localeCompare(b.name));
}

const getHomepageSnapshot = unstable_cache(
  async () => {
    const allEvents = await TBA.getEvents(new Date().getFullYear());
    const weekEvents = getCalendarWeekEvents(allEvents);

    // Read the canonical full event match cache. TBAClient handles Redis freshness,
    // ETags, webhook mutations, and upstream reconciliation for each schedule.
    const eventSummaries = await Promise.all(
      weekEvents.map(async (event) => {
        try {
          const matches = sortMatches(await TBA.getEventMatches(event.key));
          return {
            event,
            lastMatch: getLastMatch(matches),
            nextMatch: getNextMatch(matches),
          };
        } catch (error) {
          console.error(`Failed to load homepage match summary for ${event.key}:`, error);
          return { event, lastMatch: null, nextMatch: null };
        }
      }),
    );

    return { eventSummaries };
  },
  ["homepage-event-snapshot"],
  { revalidate: 3600, tags: ["homepage-events"] },
);

export default async function HomePage() {
  const { eventSummaries } = await getHomepageSnapshot();
  const now = new Date();
  const statusOrder = { inProgress: 0, upcoming: 1, completed: 2 } as const;
  const sortedEventSummaries = [...eventSummaries].sort((a, b) =>
    statusOrder[getEventCompetitionStatus(
      a.event.start_date,
      a.event.end_date,
      a.event.timezone,
      now,
    )] - statusOrder[getEventCompetitionStatus(
      b.event.start_date,
      b.event.end_date,
      b.event.timezone,
      now,
    )]
    || a.event.start_date.localeCompare(b.event.start_date)
    || a.event.name.localeCompare(b.event.name),
  );

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

        <section className="mt-8">
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-[var(--fv-brand)]">
                <CalendarDaysIcon className="h-5 w-5" />
                <span className="text-xs font-bold uppercase tracking-[0.16em]">Events this week</span>
              </div>
              <h2 className="mt-1 text-2xl font-bold text-slate-900">{eventSummaries.length} {eventSummaries.length === 1 ? "event" : "events"}</h2>
            </div>
            <Link href="/events" className="hidden text-sm font-semibold text-[var(--fv-brand)] hover:text-[var(--fv-brand-strong)] sm:block">Browse all events →</Link>
          </div>

          {eventSummaries.length ? (
            <div className="mt-5 grid gap-4 xl:grid-cols-2">
              {sortedEventSummaries.map((summary) => (
                <HomeEventCard key={summary.event.key} {...summary} />
              ))}
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">There are no events scheduled for this week.</div>
          )}

          <Link href="/events" className="mt-4 block text-center text-sm font-semibold text-[var(--fv-brand)] sm:hidden">Browse all events →</Link>
        </section>
      </div>
    </SiteShell>
  );
}
