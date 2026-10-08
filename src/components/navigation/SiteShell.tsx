"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ArrowTopRightOnSquareIcon,
  Bars3Icon,
  CalendarDaysIcon,
  MagnifyingGlassIcon,
  TvIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type { TBAEvent } from "@/lib/tba/types";

type NavigationEvent = Pick<
  TBAEvent,
  | "key"
  | "name"
  | "short_name"
  | "city"
  | "state_prov"
  | "country"
  | "start_date"
  | "end_date"
>;

export default function SiteShell({
  children,
  events,
  selectedEventKey,
}: {
  children: React.ReactNode;
  events: NavigationEvent[];
  selectedEventKey?: string;
}) {
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const filteredEvents = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    if (!normalized) {
      return events;
    }

    return events.filter((event) =>
      [
        event.key,
        event.name,
        event.short_name,
        event.city,
        event.state_prov,
        event.country,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalized)
    );
  }, [events, query]);

  const thisWeek = filteredEvents.filter((event) =>
    overlapsCurrentWeek(event.start_date, event.end_date)
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-3 px-4 lg:px-6">
          <button
            type="button"
            onClick={() => setSidebarOpen((open) => !open)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 lg:hidden"
            aria-label="Toggle event navigation"
          >
            {sidebarOpen ? (
              <XMarkIcon className="h-5 w-5" />
            ) : (
              <Bars3Icon className="h-5 w-5" />
            )}
          </button>

          <Link href="/" className="shrink-0">
            <span className="text-xl font-black tracking-tight text-slate-900">
              Field<span className="text-blue-600">View</span>
            </span>
            <span className="ml-2 hidden text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400 sm:inline">
              FIRST Robotics
            </span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            <NavLink href="/" active={!selectedEventKey}>
              Events
            </NavLink>
            <NavLink href="/teams">Teams</NavLink>
            <NavLink href="/gameday">Gameday</NavLink>
          </nav>

          <div className="relative mx-auto hidden w-full max-w-md lg:block">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search events, teams, or event keys"
              className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none transition focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100"
            />
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/remote/display"
              className="hidden items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 sm:flex"
            >
              <TvIcon className="h-4 w-4" />
              Remote Display
            </Link>
            <Link
              href="/remote"
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-700"
            >
              Remote Controller
            </Link>
          </div>
        </div>

        <div className="border-t border-slate-100 px-4 py-2 lg:hidden">
          <div className="relative">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search events, teams, or event keys"
              className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100"
            />
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1600px]">
        <aside
          className={[
            "w-full shrink-0 border-r border-slate-200 bg-white lg:sticky lg:top-16 lg:block lg:h-[calc(100vh-4rem)] lg:w-64 lg:overflow-y-auto",
            sidebarOpen ? "block" : "hidden",
          ].join(" ")}
        >
          <div className="border-b border-slate-100 px-4 py-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">
                  Event selector
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-800">
                  {thisWeek.length} this week
                </p>
              </div>
              <CalendarDaysIcon className="h-5 w-5 text-blue-500" />
            </div>
          </div>

          <div className="p-3">
            <p className="px-2 pb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              This week
            </p>

            <div className="space-y-1">
              {thisWeek.length ? (
                thisWeek.map((event) => (
                  <EventLink
                    key={event.key}
                    event={event}
                    selected={event.key === selectedEventKey}
                    onClick={() => setSidebarOpen(false)}
                  />
                ))
              ) : (
                <p className="px-2 py-3 text-xs text-slate-400">
                  No matching events.
                </p>
              )}
            </div>

            <div className="my-4 border-t border-slate-100" />

            <p className="px-2 pb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              All events
            </p>

            <div className="space-y-1">
              {filteredEvents.slice(0, 30).map((event) => (
                <EventLink
                  key={event.key}
                  event={event}
                  selected={event.key === selectedEventKey}
                  onClick={() => setSidebarOpen(false)}
                />
              ))}
            </div>

            {filteredEvents.length > 30 && (
              <Link
                href="/events"
                onClick={() => setSidebarOpen(false)}
                className="mt-3 flex items-center justify-between rounded-lg px-2 py-2 text-xs font-semibold text-blue-600 hover:bg-blue-50"
              >
                Browse all events
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={[
        "rounded-lg px-3 py-2 text-sm font-semibold transition",
        active
          ? "bg-blue-50 text-blue-700"
          : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
      ].join(" ")}
    >
      {children}
    </Link>
  );
}

function EventLink({
  event,
  selected,
  onClick,
}: {
  event: NavigationEvent;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Link
      href={`/event/${event.key}`}
      onClick={onClick}
      className={[
        "block rounded-lg px-3 py-2.5 transition",
        selected
          ? "bg-blue-50 text-blue-700"
          : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
      ].join(" ")}
    >
      <p className="truncate text-sm font-semibold">
        {event.short_name || event.name || event.key}
      </p>
      <p className="mt-0.5 truncate text-[11px] text-slate-400">
        {event.city}
        {event.state_prov ? `, ${event.state_prov}` : ""}
      </p>
    </Link>
  );
}

function overlapsCurrentWeek(startDate: string, endDate: string) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());

  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  const eventStart = parseDate(startDate);
  const eventEnd = parseDate(endDate);

  return eventStart <= end && eventEnd >= start;
}

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}
