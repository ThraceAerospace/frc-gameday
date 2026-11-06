import Link from "next/link";
import { ChevronRightIcon, MapPinIcon, VideoCameraIcon } from "@heroicons/react/24/outline";
import MatchCard from "@/components/match/MatchCard";
import type { TBAEvent, TBAMatch } from "@/lib/tba/types";
import { formatEventName, getEventWebcastStatus } from "@/lib/tba/formatters";
import { formatEventDateRange } from "@/lib/time";

type HomeEventCardProps = {
  event: TBAEvent;
  lastMatch: TBAMatch | null;
  nextMatch: TBAMatch | null;
};

function getCompetitionStatus(lastMatch: TBAMatch | null, nextMatch: TBAMatch | null) {
  if (lastMatch && nextMatch) {
    return { label: "In progress", className: "bg-emerald-50 text-emerald-700" };
  }

  if (lastMatch) {
    return { label: "Completed", className: "bg-slate-100 text-slate-600" };
  }

  if (nextMatch) {
    return { label: "Upcoming", className: "bg-blue-50 text-blue-700" };
  }

  return { label: "Match data unavailable", className: "bg-slate-100 text-slate-500" };
}

export default function HomeEventCard({ event, lastMatch, nextMatch }: HomeEventCardProps) {
  const eventName = formatEventName(event.short_name || event.name, event.name);
  const location = [event.city, event.state_prov, event.country].filter(Boolean).join(", ");
  const webcastStatus = getEventWebcastStatus(event);
  const webcastLabel =
    webcastStatus === "Live"
      ? "Livestream online"
      : webcastStatus === "Offline"
        ? "Webcast offline"
        : "No webcast";
  const competitionStatus = getCompetitionStatus(lastMatch, nextMatch);

  return (
    <Link
      href={`/event/${event.key}`}
      className="group min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-bold text-slate-900 group-hover:text-blue-700">{eventName}</h3>
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-700">
              {event.event_type_string || "FRC event"}
            </span>
          </div>
          <p className="mt-1 text-xs font-medium text-slate-400">{event.key}</p>
        </div>
        <ChevronRightIcon className="h-5 w-5 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-blue-500" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-medium">
        <span className="flex min-w-0 items-center gap-1.5 text-slate-500">
          <MapPinIcon className="h-4 w-4 shrink-0 text-slate-400" />
          <span>{location || "Location unavailable"}</span>
        </span>
        <span className={`flex items-center gap-1.5 ${webcastStatus === "Live" ? "text-emerald-600" : "text-slate-500"}`}>
          <VideoCameraIcon className="h-4 w-4" />
          {webcastLabel}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${competitionStatus.className}`}>
          {competitionStatus.label}
        </span>
        <span className="text-xs font-medium text-slate-500">
          {formatEventDateRange(event.start_date, event.end_date)}
        </span>
      </div>

      <div className="mt-4 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Last match</p>
          {lastMatch ? (
            <MatchCard match={lastMatch} eventTimezone={event.timezone ?? undefined} playoffType={event.playoff_type ?? null} />
          ) : (
            <div className="flex min-h-12 items-center rounded-md border border-dashed border-slate-200 px-3 text-xs text-slate-400">
              No completed matches yet
            </div>
          )}
        </div>

        {nextMatch ? (
          <div className="min-w-0">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Next match</p>
            <MatchCard match={nextMatch} isNext eventTimezone={event.timezone ?? undefined} playoffType={event.playoff_type ?? null} />
          </div>
        ) : null}
      </div>
    </Link>
  );
}
