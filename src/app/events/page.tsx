"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { FunnelIcon } from "@heroicons/react/24/outline";
import SiteShell from "@/components/navigation/SiteShell";
import type { TBAEvent } from "@/lib/tba/types";

type GroupMode = "week" | "type";

export default function EventsPage() {
  const [events, setEvents] = useState<TBAEvent[]>([]);
  const [mode, setMode] = useState<GroupMode>("week");
  const [district, setDistrict] = useState("all");
  const [date, setDate] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);

  return <EventsContent events={events} mode={mode} setMode={setMode} district={district} setDistrict={setDistrict} date={date} setDate={setDate} filterOpen={filterOpen} setFilterOpen={setFilterOpen} />;
}

function EventsContent({ events, mode, setMode, district, setDistrict, date, setDate, filterOpen, setFilterOpen }: any) {
  const filtered = useMemo(() => events.filter((event) => {
    const districtKey = event.district?.key ?? "none";
    const matchesDistrict = district === "all" || districtKey === district;
    const matchesDate = date === "all" || event.start_date === date || event.end_date === date || (event.start_date <= date && event.end_date >= date);
    return matchesDistrict && matchesDate;
  }), [events, district, date]);

  const groups = useMemo(() => {
    const map = new Map<string, TBAEvent[]>();
    for (const event of filtered) {
      const key = mode === "week" ? (event.week != null ? `Week ${event.week}` : event.event_type_string ?? String(event.event_type)) : (event.event_type_string ?? String(event.event_type));
      const list = map.get(key) ?? [];
      list.push(event);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [filtered, mode]);

  const districts = [...new Map(events.map((e) => [e.district?.key, e.district?.display_name]).filter(([k]) => k)).entries()];
  const dates = [...new Set(events.flatMap((e) => [e.start_date, e.end_date]).filter(Boolean))].sort();

  return (
    <SiteShell events={events}>
      <div className="mx-auto max-w-6xl px-5 py-8 lg:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">Events</p><h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">FIRST events</h1></div>
          <button onClick={() => setFilterOpen(!filterOpen)} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700"><FunnelIcon className="h-4 w-4" />Filters</button>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200">
          <div className="flex gap-1">
            {(["week", "type"] as GroupMode[]).map((value) => <button key={value} onClick={() => setMode(value)} className={`border-b-2 px-4 py-3 text-sm font-semibold ${mode === value ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500"}`}>{value === "week" ? "Week" : "Event Type"}</button>)}
          </div>
          <span className="pb-3 text-xs text-slate-400">{filtered.length} events</span>
        </div>

        {filterOpen && <div className="mt-4 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2"><label className="text-sm font-semibold text-slate-700">District<select value={district} onChange={(e) => setDistrict(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal"><option value="all">All districts</option>{districts.map(([key,name]) => <option key={key} value={key}>{name || key}</option>)}</select></label><label className="text-sm font-semibold text-slate-700">Date<select value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal"><option value="all">All dates</option>{dates.map((value) => <option key={value} value={value}>{value}</option>)}</select></label></div>}

        <div className="mt-6 space-y-8">
          {groups.map(([group, groupEvents]) => <section key={group}><h2 className="mb-3 text-lg font-bold text-slate-900">{group}</h2><div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">{groupEvents.map((event, index) => <Link key={event.key} href={`/event/${event.key}`} className={`flex items-center justify-between gap-4 px-5 py-4 hover:bg-blue-50/60 ${index ? "border-t border-slate-100" : ""}`}><div className="min-w-0"><p className="truncate font-semibold">{event.name}</p><p className="mt-1 text-xs text-slate-400">{event.key} · {event.start_date} – {event.end_date} · {event.city}{event.state_prov ? `, ${event.state_prov}` : ""}</p></div><span className="shrink-0 text-xs font-semibold text-blue-600">View →</span></Link>)}</div></section>)}
        </div>
      </div>
    </SiteShell>
  );
}
