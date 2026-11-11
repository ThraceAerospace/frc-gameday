import {
  CalendarDaysIcon,
  ChevronRightIcon,
  MapPinIcon,
  VideoCameraIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import HomeMatchCard from "@/components/event/HomeMatchCard";
import type { TBAEvent, TBAMatch } from "@/lib/tba/types";
import { formatEventName, getEventWebcastStatus } from "@/lib/tba/formatters";
import { formatEventDateRange, getEventCompetitionStatus } from "@/lib/time";

type HomeEventCardProps = {
  event: TBAEvent;
  lastMatch: TBAMatch | null;
  nextMatch: TBAMatch | null;
};

function getCompetitionStatus(event: TBAEvent) {
  const status = getEventCompetitionStatus(
    event.start_date,
    event.end_date,
    event.timezone,
  );

  if (status === "upcoming") return { label: "Upcoming", className: "bg-blue-50 text-blue-700 ring-blue-200" };
  if (status === "completed") return { label: "Completed", className: "bg-slate-100 text-slate-600 ring-slate-200" };
  return { label: "In progress", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" };
}

export default function HomeEventCard({ event, lastMatch, nextMatch }: HomeEventCardProps) {
  const eventName = formatEventName(event.short_name || event.name, event.name);
  const location = [event.city, event.state_prov, event.country].filter(Boolean).join(", ");
  const webcastStatus = getEventWebcastStatus(event);
  const competitionStatus = getCompetitionStatus(event);
  const webcastLabel = webcastStatus === "Live"
    ? "Watch webcast"
    : webcastStatus === "Offline"
      ? "Webcast offline"
      : "No webcast";
  const webcastClass = webcastStatus === "Live"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
    : "border-slate-200 bg-slate-50 text-slate-500";

  return (
    <article className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:border-[var(--fv-brand-border)] hover:shadow-md">
      <div className="p-4">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 text-sm font-bold leading-snug text-slate-900">
            <Link href={`/event/${event.key}`} className="hover:text-[var(--fv-brand)]">{eventName}</Link>
          </h3>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ring-1 ring-inset ${competitionStatus.className} ${competitionStatus.label === "In progress" ? "dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800" : ""}`}>
            {competitionStatus.label}
          </span>
          <Link href={`/event/${event.key}`} aria-label={`View ${eventName}`} className="ml-auto shrink-0 text-slate-300 hover:text-[var(--fv-brand)]">
            <ChevronRightIcon className="h-4 w-4" />
          </Link>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] font-medium text-slate-500">
          <span className="flex items-center gap-1.5">
            <CalendarDaysIcon className="h-3.5 w-3.5 text-slate-400" />
            {formatEventDateRange(event.start_date, event.end_date)}
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <MapPinIcon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span>{location || "Location unavailable"}</span>
          </span>
        </div>

        <Link
          href={`/event/${event.key}`}
          aria-disabled={webcastStatus === "No Webcast"}
          className={`mt-3 inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-[11px] font-semibold transition ${webcastClass} ${webcastStatus === "No Webcast" ? "pointer-events-none" : ""}`}
        >
          <VideoCameraIcon className="h-3.5 w-3.5" />
          {webcastLabel}
          {webcastStatus === "Live" ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> : null}
        </Link>

        <div className="mt-4 grid min-w-0 grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div className="min-w-0">
            <p className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">Last match</p>
            {lastMatch ? (
              <HomeMatchCard match={lastMatch} eventTimezone={event.timezone ?? undefined} />
            ) : (
              <div className="flex min-h-[64px] items-center rounded-md border border-dashed border-slate-200 px-2.5 text-[11px] text-slate-400">
                No completed matches yet
              </div>
            )}
          </div>
          {nextMatch ? (
            <div className="min-w-0">
              <p className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">Next match</p>
              <HomeMatchCard match={nextMatch} eventTimezone={event.timezone ?? undefined} isNext />
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
