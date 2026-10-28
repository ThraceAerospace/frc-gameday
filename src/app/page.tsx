import Link from "next/link";
import { CalendarDaysIcon, ChevronRightIcon, MapPinIcon, VideoCameraIcon } from "@heroicons/react/24/outline";
import SiteShell from "@/components/navigation/SiteShell";
import EventDateRange from "@/components/event/EventDateRange";
import { TBA } from "@/lib/tba/service";
import type { TBAEvent } from "@/lib/tba/types";

function getCalendarWeekEvents(events: TBAEvent[], now = new Date()) {
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  const date = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  };

  return events
    .filter((event) => date(event.start_date) <= weekEnd && date(event.end_date) >= weekStart)
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.name.localeCompare(b.name));
}

function getWebcastStatus(event: TBAEvent): "Live" | "Offline" | "No Webcast" {
  const webcasts = event.webcasts ?? [];
  if (!webcasts.length) return "No Webcast";
  return webcasts.some((webcast) => webcast.status === "online") ? "Live" : "Offline";
}

export default async function HomePage() {
  const allEvents = await TBA.getEvents(new Date().getFullYear());
  const weekEvents = getCalendarWeekEvents(allEvents);

  return (
    <SiteShell events={allEvents}>
      <div className="mx-auto max-w-6xl px-5 py-8 lg:px-8 lg:py-10">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">FIRST Robotics Competition</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">This week in FIRST</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500">
            Browse events, teams, matches, and live Gameday views. FieldView starts with The Blue Alliance data and builds richer live-event tools on top of it.
          </p>
        </section>

        <section className="mt-8">
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-blue-600">
                <CalendarDaysIcon className="h-5 w-5" />
                <span className="text-xs font-bold uppercase tracking-[0.16em]">Events this week</span>
              </div>
              <h2 className="mt-1 text-2xl font-bold text-slate-900">{weekEvents.length} {weekEvents.length === 1 ? "event" : "events"}</h2>
            </div>
            <Link href="/events" className="hidden text-sm font-semibold text-blue-600 hover:text-blue-700 sm:block">Browse all events →</Link>
          </div>

          {weekEvents.length ? (
            <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {weekEvents.map((event) => {
                const webcastStatus = getWebcastStatus(event);
                return (
                  <Link key={event.key} href={`/event/${event.key}`} className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate font-bold text-slate-900 group-hover:text-blue-700">{event.short_name || event.name}</h3>
                        <p className="mt-1 text-xs font-medium text-slate-400">{event.key}</p>
                      </div>
                      <ChevronRightIcon className="h-5 w-5 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-blue-500" />
                    </div>

                    <div className="mt-5 flex items-center gap-2 text-sm text-slate-500">
                      <MapPinIcon className="h-4 w-4 shrink-0 text-slate-400" />
                      <span>{event.city}{event.state_prov ? `, ${event.state_prov}` : ""}{event.country ? `, ${event.country}` : ""}</span>
                    </div>

                    <p className="mt-3 text-sm font-medium text-slate-600">
                      <EventDateRange startDate={event.start_date} endDate={event.end_date} />
                    </p>
                    <p className="mt-3 flex items-center gap-1.5 text-xs font-semibold">
                      <VideoCameraIcon className="h-4 w-4" />
                      <span className={webcastStatus === "Live" ? "text-emerald-600" : "text-slate-500"}>{webcastStatus}</span>
                    </p>
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">There are no events scheduled for this week.</div>
          )}

          <Link href="/events" className="mt-4 block text-center text-sm font-semibold text-blue-600 sm:hidden">Browse all events →</Link>
        </section>
      </div>
    </SiteShell>
  );
}
