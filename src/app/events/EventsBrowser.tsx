"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { FunnelIcon, VideoCameraIcon } from "@heroicons/react/24/outline";
import SiteShell from "@/components/navigation/SiteShell";
import EventDateRange from "@/components/event/EventDateRange";
import type { TBAEvent } from "@/lib/tba/types";
import { getEventWebcastStatus } from "@/lib/tba/formatters";

function getEventGroup(event: TBAEvent): string {
  if (event.week != null) return `Week ${event.week}`;

  const type = event.event_type_string?.trim();
  if (type) return type;
  return "Other";
}

function compareGroups(a: string, b: string): number {
  const weekA = /^Week (\d+)$/i.exec(a);
  const weekB = /^Week (\d+)$/i.exec(b);
  if (weekA && weekB) return Number(weekA[1]) - Number(weekB[1]);
  if (weekA) return -1;
  if (weekB) return 1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export default function EventsBrowser({ events }: { events: TBAEvent[] }) {
  const [selectedGroup, setSelectedGroup] = useState<string>("all");
  const [district, setDistrict] = useState("all");
  const [eventType, setEventType] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);

  const eventTypes = useMemo(() => [...new Set(
    events.map((event) => event.event_type_string?.trim()).filter((value): value is string => Boolean(value))
  )].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })), [events]);

  const districts = useMemo(() => [...new Map(
    events.filter((event) => event.district?.key).map((event) => [
      event.district!.key,
      event.district!.display_name ?? event.district!.key,
    ])
  ).entries()].sort((a, b) => a[1].localeCompare(b[1])), [events]);

  const filtered = useMemo(() => events.filter((event) => {
    const districtKey = event.district?.key ?? "none";
    return (district === "all" || districtKey === district) &&
      (eventType === "all" || event.event_type_string === eventType);
  }), [events, district, eventType]);

  const groups = useMemo(() => {
    const groupMap = new Map<string, TBAEvent[]>();
    for (const event of filtered) {
      const group = getEventGroup(event);
      const groupEvents = groupMap.get(group) ?? [];
      groupEvents.push(event);
      groupMap.set(group, groupEvents);
    }

    return [...groupMap.entries()]
      .map(([name, groupEvents]) => [
        name,
        [...groupEvents].sort((a, b) =>
          a.start_date.localeCompare(b.start_date) ||
          a.name.localeCompare(b.name, undefined, { numeric: true }) ||
          a.key.localeCompare(b.key, undefined, { numeric: true })
        ),
      ] as [string, TBAEvent[]])
      .sort(([a], [b]) => compareGroups(a, b));
  }, [filtered]);

  const activeGroup = selectedGroup === "all" || !groups.some(([name]) => name === selectedGroup)
    ? groups[0]?.[0] ?? "all"
    : selectedGroup;
  const activeEvents = groups.find(([name]) => name === activeGroup)?.[1] ?? [];

  return (
    <SiteShell events={events}>
      <div className="mx-auto max-w-6xl px-5 py-8 lg:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">Events</p>
            <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">FIRST events</h1>
            <p className="mt-2 text-sm text-slate-500">{filtered.length} of {events.length} events</p>
          </div>
          <button onClick={() => setFilterOpen((open) => !open)} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50" aria-expanded={filterOpen}>
            <FunnelIcon className="h-4 w-4" /> Filters
          </button>
        </div>

        {filterOpen && (
          <div className="mt-4 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2">
            <label className="text-sm font-semibold text-slate-700">
              Event type
              <select value={eventType} onChange={(e) => {
                setEventType(e.target.value);
                setSelectedGroup("all");
              }} className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal">
                <option value="all">All event types</option>
                {eventTypes.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label className="text-sm font-semibold text-slate-700">
              District
              <select value={district} onChange={(e) => {
                setDistrict(e.target.value);
                setSelectedGroup("all");
              }} className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal">
                <option value="all">All districts</option>
                {districts.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
              </select>
            </label>
          </div>
        )}

        <nav aria-label="Event groups" className="mt-5 flex gap-1 overflow-x-auto border-b border-slate-200">
          {groups.map(([group, groupEvents]) => (
            <button
              key={group}
              type="button"
              onClick={() => setSelectedGroup(group)}
              aria-current={activeGroup === group ? "page" : undefined}
              className={`shrink-0 border-b-2 px-4 py-3 text-sm font-semibold transition-colors ${activeGroup === group ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
            >
              {group} <span className={`ml-1 text-xs ${activeGroup === group ? "text-blue-600" : "text-slate-400"}`}>{groupEvents.length}</span>
            </button>
          ))}
        </nav>

        {activeEvents.length ? (
          <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            {activeEvents.map((event, index) => {
              const webcastStatus = getEventWebcastStatus(event);
              return (
                <Link key={event.key} href={`/event/${event.key}`} className={`flex items-center justify-between gap-4 px-5 py-4 hover:bg-blue-50/60 ${index ? "border-t border-slate-100" : ""}`}>
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-900">{event.name}</p>
                    <p className="mt-1 text-xs text-slate-500">{event.city}{event.state_prov ? `, ${event.state_prov}` : ""}{event.country ? `, ${event.country}` : ""}</p>
                    <p className="mt-1 text-xs text-slate-400"><EventDateRange startDate={event.start_date} endDate={event.end_date} /> · {event.key}</p>
                    <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold">
                      <VideoCameraIcon className="h-4 w-4" />
                      <span className={webcastStatus === "Live" ? "text-emerald-600" : "text-slate-500"}>{webcastStatus}</span>
                    </p>
                  </div>
                  <span className="shrink-0 text-xs font-semibold text-blue-600">View →</span>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
            No events match these filters.
          </div>
        )}
      </div>
    </SiteShell>
  );
}
