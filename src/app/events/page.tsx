import Link from "next/link";
import { TBA } from "@/lib/tba/service";
import SiteShell from "@/components/navigation/SiteShell";

export default async function EventsPage() {
  const events = await TBA.getEvents(new Date().getFullYear());

  return (
    <SiteShell events={events}>
      <div className="mx-auto max-w-6xl px-5 py-8 lg:px-8 lg:py-10">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">
            Events
          </p>
          <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">
            FIRST events
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Select an event from the sidebar or browse the full {new Date().getFullYear()} season below.
          </p>
        </div>

        <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          {events.map((event, index) => (
            <Link
              key={event.key}
              href={`/event/${event.key}`}
              className={`flex items-center justify-between gap-4 px-5 py-4 transition hover:bg-blue-50/60 ${index ? "border-t border-slate-100" : ""}`}
            >
              <div className="min-w-0">
                <p className="truncate font-semibold text-slate-900">
                  {event.name}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {event.key} · {event.city}
                  {event.state_prov ? `, ${event.state_prov}` : ""}
                </p>
              </div>
              <span className="shrink-0 text-xs font-semibold text-blue-600">
                View event →
              </span>
            </Link>
          ))}
        </div>
      </div>
    </SiteShell>
  );
}
