import Link from "next/link";
import { CalendarDaysIcon, ChevronRightIcon, MapPinIcon } from "@heroicons/react/24/outline";
import SiteShell from "@/components/navigation/SiteShell";
import { TBA } from "@/lib/tba/service";

export default async function HomePage() {
  const events = await TBA.getEvents(new Date().getFullYear());
  const weekEvents = await TBA.getActiveEvents(new Date().getFullYear());

  return (
    <SiteShell events={events}>
      <div className="mx-auto max-w-6xl px-5 py-8 lg:px-8 lg:py-10">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">
            FIRST Robotics Competition
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
            This week in FIRST
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500">
            Browse events, teams, matches, and live Gameday views. FieldView
            starts with The Blue Alliance data and builds richer live-event
            tools on top of it.
          </p>
        </section>

        <section className="mt-8">
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-blue-600">
                <CalendarDaysIcon className="h-5 w-5" />
                <span className="text-xs font-bold uppercase tracking-[0.16em]">
                  Events this week
                </span>
              </div>
              <h2 className="mt-1 text-2xl font-bold text-slate-900">
                {weekEvents.length} {weekEvents.length === 1 ? "event" : "events"}
              </h2>
            </div>
            <Link
              href="/events"
              className="hidden text-sm font-semibold text-blue-600 hover:text-blue-700 sm:block"
            >
              Browse all events →
            </Link>
          </div>

          {weekEvents.length ? (
            <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {weekEvents.map((event) => (
                <Link
                  key={event.key}
                  href={`/event/${event.key}`}
                  className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-bold text-slate-900 group-hover:text-blue-700">
                        {event.short_name || event.name}
                      </h3>
                      <p className="mt-1 text-xs font-medium text-slate-400">
                        {event.key}
                      </p>
                    </div>
                    <ChevronRightIcon className="h-5 w-5 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-blue-500" />
                  </div>

                  <div className="mt-5 flex items-center gap-2 text-sm text-slate-500">
                    <MapPinIcon className="h-4 w-4 shrink-0 text-slate-400" />
                    <span>
                      {event.city}
                      {event.state_prov ? `, ${event.state_prov}` : ""}
                      {event.country ? `, ${event.country}` : ""}
                    </span>
                  </div>

                  <p className="mt-3 text-xs text-slate-400">
                    {event.start_date} – {event.end_date}
                  </p>
                </Link>
              ))}
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
              There are no events scheduled for this week.
            </div>
          )}

          <Link
            href="/events"
            className="mt-4 block text-center text-sm font-semibold text-blue-600 sm:hidden"
          >
            Browse all events →
          </Link>
        </section>
      </div>
    </SiteShell>
  );
}
