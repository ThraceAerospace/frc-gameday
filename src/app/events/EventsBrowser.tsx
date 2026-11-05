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
  // TBA event type IDs: 2/5 are District Championship events, while
  // 3/4 are the FIRST Championship divisions/finals.
  if (event.event_type === 100) return "Preseason";
  if (event.event_type === 2 || event.event_type === 5) return "District Championship";
  if (event.event_type === 3 || event.event_type === 4) return "FIRST Championship";
  if (event.event_type === 99) return "Off-Season";
  // TBA's week field is zero-indexed relative to the first official week.
  // Preseason events are separately grouped above and do not shift this value.
  if (event.week != null) return `Week ${event.week + 1}`;
  return type || "Other";
}

function getGroupId(group: string): string {
  return `event-group-${group.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function getOffseasonMonthId(monthKey: string): string {
  return `offseason-month-${monthKey}`;
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
  const [activeOffseasonMonth, setActiveOffseasonMonth] = useState("");

  const eventTypes = useMemo(() => {
    const typeLabels = new Map<number, string>();
    for (const event of events) {
      const label = event.event_type_string?.trim();
      if (label) typeLabels.set(event.event_type, label);
    }

    // Keep the display order tied to TBA's numeric event type IDs, not labels.
    const preferredOrder = [100, 0, 1, 5, 2, 3, 4, 99];
    const orderedIds = [
      ...preferredOrder.filter((id) => typeLabels.has(id)),
      ...[...typeLabels.keys()]
        .filter((id) => !preferredOrder.includes(id))
        .sort((a, b) => a - b),
    ];

    return orderedIds.map((id) => ({ id, label: typeLabels.get(id)! }));
  }, [events]);

  const districts = useMemo(() => [...new Map(
    events.filter((event) => event.district?.key).map((event) => [
      event.district!.key,
      event.district!.display_name ?? event.district!.key,
    ])
  ).entries()].sort((a, b) => a[1].localeCompare(b[1])), [events]);

  const filtered = useMemo(() => events.filter((event) => {
    const districtKey = event.district?.key ?? "none";
    return (district === "all" || districtKey === district) &&
      (eventType === "all" || event.event_type === Number(eventType));
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

  const offseasonMonths = useMemo(() => {
    const offseason = groups.find(([name]) => name === "Off-Season");
    if (!offseason) return [];

    const monthMap = new Map<string, TBAEvent[]>();
    for (const event of offseason[1]) {
      const match = /^(\d{4})-(\d{2})-/.exec(event.start_date);
      if (!match) continue;
      const monthKey = `${match[1]}-${match[2]}`;
      const monthEvents = monthMap.get(monthKey) ?? [];
      monthEvents.push(event);
      monthMap.set(monthKey, monthEvents);
    }

    const hasMultipleYears = new Set([...monthMap.keys()].map((key) => key.slice(0, 4))).size > 1;
    return [...monthMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, monthEvents]) => {
        const [year, month] = key.split("-").map(Number);
        const label = new Date(year, month - 1, 1).toLocaleString(undefined, { month: "long" });
        return {
          key,
          id: getOffseasonMonthId(key),
          label: hasMultipleYears ? `${label} ${year}` : label,
          events: monthEvents,
        };
      });
  }, [groups]);

  useEffect(() => {
    if (!groups.length) {
      setActiveGroup("");
      setActiveOffseasonMonth("");
      return;
    }

    const scrollspyIds = groups.flatMap(([name]) => {
      const groupId = getGroupId(name);
      return name === "Off-Season"
        ? [groupId, ...offseasonMonths.map(({ id }) => id)]
        : [groupId];
    });
    const sections = scrollspyIds
      .map((id) => document.getElementById(id))
      .filter((section): section is HTMLElement => section !== null);
    const scrollContainer = document.querySelector("[data-scroll-container]");

    if (!sections.length || !scrollContainer) return;

    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (!visible[0]) return;

      const activeId = visible[0].target.id;
      const activeMonth = offseasonMonths.find(({ id }) => id === activeId);
      if (activeMonth) {
        setActiveGroup(getGroupId("Off-Season"));
        setActiveOffseasonMonth(activeMonth.id);
      } else {
        setActiveGroup(activeId);
        setActiveOffseasonMonth("");
      }
    }, {
      root: scrollContainer,
      rootMargin: "-15% 0px -70% 0px",
      threshold: 0,
    });

    sections.forEach((section) => observer.observe(section));
    const firstId = scrollspyIds[0];
    setActiveGroup((current) => scrollspyIds.includes(current) ? current : firstId);
    setActiveOffseasonMonth((current) =>
      offseasonMonths.some(({ id }) => id === current) ? current : ""
    );

    return () => observer.disconnect();
  }, [groups, offseasonMonths]);

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
                <option value="all">All Events</option>
                {eventTypes.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
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
                  <div key={group} className="shrink-0 lg:shrink">
                    <a
                      href={`#${id}`}
                      onClick={() => {
                        setActiveGroup(id);
                        setActiveOffseasonMonth("");
                      }}
                      aria-current={isActive ? "location" : undefined}
                      className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${isActive ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"}`}
                    >
                      <span>{group}</span>
                      <span className={`text-xs tabular-nums ${isActive ? "text-blue-600" : "text-slate-400"}`}>{groupEvents.length}</span>
                    </a>
                    {group === "Off-Season" && isActive && offseasonMonths.length > 0 && (
                      <div className="mt-1 flex gap-1 overflow-x-auto whitespace-nowrap px-1 pb-1 lg:ml-3 lg:flex-col lg:space-y-0.5 lg:overflow-visible lg:border-l lg:border-slate-200 lg:pl-2">
                        {offseasonMonths.map(({ id: monthId, label, events: monthEvents }) => {
                          const monthIsActive = activeOffseasonMonth === monthId;
                          return (
                            <a
                              key={monthId}
                              href={`#${monthId}`}
                              onClick={() => {
                                setActiveGroup(id);
                                setActiveOffseasonMonth(monthId);
                              }}
                              aria-current={monthIsActive ? "location" : undefined}
                              className={`flex shrink-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${monthIsActive ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"}`}
                            >
                              <span>{label}</span>
                              <span className={`tabular-nums ${monthIsActive ? "text-blue-600" : "text-slate-400"}`}>{monthEvents.length}</span>
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </nav>
          </aside>

          <div className="min-w-0 space-y-8">
            {groups.map(([group, groupEvents]) => (
              <section key={group} className="scroll-mt-6">
                <div id={getGroupId(group)} className="mb-3 flex scroll-mt-6 items-baseline justify-between gap-3">
                  <h2 className="text-lg font-bold text-slate-900">{group}</h2>
                  <span className="text-sm font-medium text-slate-400">{groupEvents.length} {groupEvents.length === 1 ? "event" : "events"}</span>
                </div>
                {group === "Off-Season" ? (
                  <div className="space-y-6">
                    {offseasonMonths.map(({ id, label, events: monthEvents }) => (
                      <section key={id} className="scroll-mt-6">
                        <div id={id} className="mb-2 flex scroll-mt-6 items-baseline justify-between gap-3">
                          <h3 className="text-sm font-bold uppercase tracking-wide text-slate-600">{label}</h3>
                          <span className="text-xs font-medium text-slate-400">{monthEvents.length} {monthEvents.length === 1 ? "event" : "events"}</span>
                        </div>
                        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                          {monthEvents.map((event, index) => {
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
                  </div>
                ) : (
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
                )}
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
