"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CalendarDaysIcon, MagnifyingGlassIcon, TvIcon, XMarkIcon, Bars3Icon } from "@heroicons/react/24/outline";
import type { TBAEvent } from "@/lib/tba/types";

type NavigationEvent = Pick<TBAEvent, "key" | "name" | "short_name" | "city" | "state_prov" | "country" | "start_date" | "end_date">;

export default function SiteShell({ children, events, selectedEventKey }: { children: React.ReactNode; events: NavigationEvent[]; selectedEventKey?: string }) {
  const [query, setQuery] = useState("");
  const thisWeek = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return events
      .filter((event) => overlapsCurrentWeek(event.start_date, event.end_date))
      .filter((event) => !normalized || [event.key, event.name, event.short_name, event.city, event.state_prov, event.country].filter(Boolean).join(" ").toLowerCase().includes(normalized));
  }, [events, query]);

  return (
    <div className="flex h-dvh min-h-0 w-full min-w-0 flex-col overflow-hidden bg-slate-50 text-slate-900">
      <header className="z-40 shrink-0 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-[1600px] min-w-0 items-center gap-3 px-4 lg:px-6">
          <button type="button" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-600 lg:hidden"><Bars3Icon className="h-5 w-5" /></button>
          <Link href="/" className="shrink-0 text-xl font-black tracking-tight text-slate-900">Field<span className="text-blue-600">View</span></Link>
          <nav className="hidden shrink-0 items-center gap-1 md:flex">
            <NavLink href="/" active={!selectedEventKey}>Events</NavLink>
            <NavLink href="/teams">Teams</NavLink>
            <NavLink href="/gameday">Gameday</NavLink>
          </nav>
          <div className="relative mx-auto hidden min-w-0 max-w-md flex-1 lg:block">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search this week's events" className="h-10 w-full min-w-0 rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100" />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Link href="/remote/display" className="hidden items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 sm:flex"><TvIcon className="h-4 w-4" />Remote Display</Link>
            <Link href="/remote" className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white">Remote Controller</Link>
          </div>
        </div>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-[1600px] min-w-0 flex-1">
        <aside className="hidden h-full w-64 shrink-0 overflow-hidden border-r border-slate-200 bg-white lg:block">
          <div className="border-b border-slate-100 px-4 py-4">
            <div className="flex items-center justify-between">
              <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Event selector</p><p className="mt-1 text-sm font-semibold text-slate-800">{thisWeek.length} this week</p></div>
              <CalendarDaysIcon className="h-5 w-5 text-blue-500" />
            </div>
          </div>
          <div className="min-w-0 p-3">
            <p className="px-2 pb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">This week</p>
            <div className="space-y-1">
              {thisWeek.length ? thisWeek.map((event) => <EventLink key={event.key} event={event} selected={event.key === selectedEventKey} />) : <p className="px-2 py-3 text-xs text-slate-400">No events this week.</p>}
            </div>
          </div>
        </aside>
        <main className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

function NavLink({ href, active, children }: { href: string; active?: boolean; children: React.ReactNode }) {
  return <Link href={href} className={`rounded-lg px-3 py-2 text-sm font-semibold ${active ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-50"}`}>{children}</Link>;
}

function EventLink({ event, selected }: { event: NavigationEvent; selected: boolean }) {
  return <Link href={`/event/${event.key}`} className={`block min-w-0 rounded-lg px-3 py-2.5 ${selected ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-50"}`}><p className="truncate text-sm font-semibold">{event.short_name || event.name || event.key}</p><p className="mt-0.5 truncate text-[11px] text-slate-400">{event.city}{event.state_prov ? `, ${event.state_prov}` : ""}</p></Link>;
}

function overlapsCurrentWeek(startDate: string, endDate: string) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return parseDate(startDate) <= end && parseDate(endDate) >= start;
}

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}
