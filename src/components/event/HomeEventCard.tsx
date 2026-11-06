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
import { formatEventDateRange } from "@/lib/time";

type HomeEventCardProps = {
  event: TBAEvent;
  lastMatch: TBAMatch | null;
  nextMatch: TBAMatch | null;
};

function getCompetitionStatus(event: TBAEvent) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: event.timezone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  );
  const today = `${parts.year}-${parts.month}-${parts.day}`;

  if (today < event.start_date) {
    return { label: "Upcoming", className: "bg-blue-50 text-blue-700 ring-blue-200" };
  }
  if (today > event.end_date) {
    return { label: "Completed", className: "bg-slate-100 text-slate-600 ring-slate-200" };
  }
  return { label: "In progress", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" };
}

export default function HomeEventCard({ event, lastMatch, nextMatch }: HomeEventCardProps) {
  const eventName = formatEventName(event.short_name || event.name, event.name);
  const location = [event.city, event.state_prov, event.country].filter(Boolean).join(", ");
  const webcastStatus = getEventWebcastStatus(event);
  const competitionStatus = getCompetitionStatus(event);
  const webcastConfig = {
    Live: {
      title: "Webcast available",
      detail: "Watch this event live",
      className: "border-emerald-200 bg-emerald-50 text-emerald-800",
      iconClassName: "text-emerald-600",
      dotClassName: "bg-emerald-500",
    },
    Offline: {
      title: "Webcast offline",
      detail: "A webcast is listed, but it is not currently online",
      className: "border-slate-200 bg-slate-50 text-slate-700",
      iconClassName: "text-slate-500",
      dotClassName: "bg-slate-400",
    },
    "No Webcast": {
      title: "No webcast",
      detail: "This event does not have a webcast listed",
      className: "border-slate-200 bg-slate-50 text-slate-600",
      iconClassName: "text-slate-400",
      dotClassName: "bg-slate-300",
    },
  }[webcastStatus];

  return (
    <article className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:border-blue-200 hover:shadow-md">
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold leading-snug text-slate-900">
              <Link href={`/event/${event.key}`} className="hover:text-blue-700">
                {eventName}
              </Link>
            </h3>
            <span className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ring-1 ring-inset ${competitionStatus.className}`}>
              {competitionStatus.label}
            </span>
          </div>
          <Link
            href={`/event/${event.key}`}
            aria-label={`View ${eventName}`}
            className="mt-0.5 shrink-0 rounded-full p-1 text-slate-300 transition hover:bg-blue-50 hover:text-blue-600"
          >
            <ChevronRightIcon className="h-5 w-5" />
          </Link>
        </div>

        <div className="mt-4 space-y-2 text-xs font-medium text-slate-500">
          <div className="flex items-center gap-2">
            <CalendarDaysIcon className="h-4 w-4 shrink-0 text-slate-400" />
            <span>{formatEventDateRange(event.start_date, event.end_date)}</span>
          </div>
          <div className="flex items-center gap-2">
            <MapPinIcon className="h-4 w-4 shrink-0 text-slate-400" />
            <span>{location || "Location unavailable"}</span>
          </div>
        </div>

        <div className={`mt-5 flex items-center gap-3 rounded-xl border px-4 py-3 ${webcastConfig.className}`}>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/80">
            <VideoCameraIcon className={`h-5 w-5 ${webcastConfig.iconClassName}`} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${webcastConfig.dotClassName}`} />
              <p className="text-sm font-bold">{webcastConfig.title}</p>
            </div>
            <p className="mt-0.5 text-xs opacity-80">{webcastConfig.detail}</p>
          </div>
        </div>

        <div className="mt-5 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Last match</p>
            {lastMatch ? (
              <HomeMatchCard match={lastMatch} eventTimezone={event.timezone ?? undefined} />
            ) : (
              <div className="flex min-h-[76px] items-center rounded-lg border border-dashed border-slate-200 px-3 text-xs text-slate-400">
                No completed matches yet
              </div>
            )}
          </div>

          {nextMatch ? (
            <div className="min-w-0">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Next match</p>
              <HomeMatchCard match={nextMatch} eventTimezone={event.timezone ?? undefined} isNext />
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
