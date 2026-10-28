"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { FunnelIcon, VideoCameraIcon } from "@heroicons/react/24/outline";
import SiteShell from "@/components/navigation/SiteShell";
import EventDateRange from "@/components/event/EventDateRange";
import type { TBAEvent } from "@/lib/tba/types";
import { getEventWebcastStatus } from "@/lib/tba/formatters";

function getEventGroup(event: TBAEvent): string {
  const type = event.event_type_string?.trim() ?? "";
  const normalizedType = type.toLowerCase();
  const normalizedName = event.name.toLowerCase();

  if (normalizedType.includes("preseason") || normalizedName.includes("preseason")) return "Preseason";
  if (
    normalizedType.includes("championship division") ||
    normalizedType.includes("championship finals") ||
    normalizedName.includes("first championship") ||
    normalizedName.includes("championship division") ||
    normalizedName.includes("championship finals")
  ) return "FIRST Championship";
  if (normalizedType.includes("offseason") || normalizedType.includes("off-season")) return "Off-Season";
  if (event.week != null) return `Week ${event.week}`;
  return type || "Other";
}

function getGroupId(group: string): string {
  return `event-group-${group.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function compareGroups(
  a: [string, TBAEvent[]],
  b: [string, TBAEvent[]]
): number {
  const [nameA, eventsA] = a;
  const [nameB, eventsB] = b;
  const rank = (name: string) => {
    if (name === "Preseason") return 0;
    const week = /^Week (\d+)$/i.exec(name);
    if (week) return 100 + Number(week[1]);
    if (name === "FIRST Championship") return 10000;
    if (name === "Off-Season") return 20000;
    return 5000;
  };
  const rankDiff = rank(nameA) - rank(nameB);
  if (rankDiff !== 0) return rankDiff;

  const firstDateA = eventsA.reduce((earliest, event) => event.start_date < earliest ? event.start_date : earliest, eventsA[0]?.start_date ?? "");
  const firstDateB = eventsB.reduce((earliest, event) => event.start_date < earliest ? event.start_date : earliest, eventsB[0]?.start_date ?? "");
  return firstDateA.localeCompare(firstDateB) || nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" });
}

export default function EventsBrowser({ events }: { events: TBAEvent[] }) {
  const [district, setDistrict] = useState("all");
  const [eventType, setEventType] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [activeGroup, setActiveGroup] = useState("");

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
      .sort(compareGroups);
  }, [filtered]);

  useEffect(() => {
    if (!groups.length) {
      setActiveGroup("");
      return;
    }

    const groupIds = groups.map(([name]) => getGroupId(name));
    const sections = groupIds
      .map((id) => document.getElementById(id))
      .filter((section): section is HTMLElement => section !== null);

    if (!sections.length) return;

    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActiveGroup(visible[0].target.id);
    }, {
      rootMargin: "-15% 0px -70% 0px",
      threshold: 0,
    });

    sections.forEach((section) => observer.observe(section));
    if (!activeGroup || !groupIds.includes(activeGroup)) setActiveGroup(groupIds[0]);

    return () => observer.disconnect();
  }, [groups, activeGroup]);

  return (
    <SiteShell events={events}>
      <div className="mx-auto max-w-7xl px-5 py-8 lg:px-8">
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
              <select value={eventType} onChange={(e) => setEventType(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal">
                <option value="all">All event types</option>
                {eventTypes.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label className="text-sm font-semibold text-slate-700">
              District
              <select value={district} onChange={(e) => setDistrict(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal">
                <option value="all">All districts</option>
                {districts.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
              </select>
            </label>
          </div>
        )}

        <div className="mt-6 items-start gap-8 lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="mb-6 lg:sticky lg:top-6 lg:mb-0">
            <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">Jump to group</h2>
            <nav aria-label="Event groups" className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-2 lg:block lg:space-y-1 lg:overflow-visible">
              {groups.map(([group, groupEvents]) => {
                const id = getGroupId(group);
                const isActive = activeGroup === id;
                return (
                  <a
                    key={group}
                    href={`#${id}`}
                    onClick={() => setActiveGroup(id)}
                    aria-current={isActive ? "location" : undefined}
                    className={`flex shrink-0 items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${isActive ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"}`}
                  >
                    <span>{group}</span>
                    <span className={`text-xs tabular-nums ${isActive ? "text-blue-600" : "text-slate-400"}`}>{groupEvents.length}</span>
                  </a>
                );
              })}
            </nav>
          </aside>

          <div className="min-w-0 space-y-8">
            {groups.map(([group, groupEvents]) => (
              <section key={group} id={getGroupId(group)} className="scroll-mt-6">
                <div className="mb-3 flex items-baseline justify-between gap-3">
                  <h2 className="text-lg font-bold text-slate-900">{group}</h2>
                  <span className="text-sm font-medium text-slate-400">{groupEvents.length} {groupEvents.length === 1 ? "event" : "events"}</span>
                </div>
                <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  {groupEvents.map((event, index) => {
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
              </section>
            ))}
            {!groups.length && (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
                No events match these filters.
              </div>
            )}
          </div>
        </div>
      </div>
    </SiteShell>
  );
}
