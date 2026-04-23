"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import MatchStrip from "@/components/gameday/navbar/MatchStrip";
import { dumbDateString } from "@/lib/time"

export default function HomePage() {
  const router = useRouter();

  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(new Set());

  useEffect(() => {
    async function loadEvents() {
      try {
        setLoading(true);
        const res = await fetch("/api/events/active");
        const data = await res.json();
        setEvents(data);
      } finally {
        setLoading(false);
      }
    }

    loadEvents();
  }, []);

  function toggleEvent(eventKey: string) {
    setSelectedEvents(prev => {
      const next = new Set(prev);
      if (next.has(eventKey)) next.delete(eventKey);
      else next.add(eventKey);
      return next;
    });
  }

  function startGameday() {
    const params = new URLSearchParams();

    selectedEvents.forEach(e => {
      params.append("event", e);
    });

    router.push(`/gameday?${params.toString()}`);
  }

  const grouped = useMemo(() => {
    const groups: Record<string, any[]> = {
      in_progress: [],
      upcoming: [],
      complete: [],
    };

    for (const e of events) {
      const state = e.state || "upcoming";
      if (!groups[state]) groups[state] = [];
      groups[state].push(e);
    }

    return groups;
  }, [events]);

  function EventCard({ event }: { event: any }) {
    const selected = selectedEvents.has(event.key);
    const hasDivisions = event.flags.hasDivisions || false
    return (
      <div className="bg-neutral-900 border-t border-neutral-700 p-3 gap-2 rounded-lg"> 
        <div className="flex justify-between items-center">
          <div>
            <div className="font-semibold">{event.name.replace("- FIRST Robotics Competition", "")}</div>
            <div><span className="text-xs opacity-70">{event.event_type_string}</span></div>
            <div><span className="text-xs">{dumbDateString(event.start_date)} - {dumbDateString(event.end_date)}</span></div>
          </div>
          <div className="flex max-w-50">
            <MatchStrip matches={event.matches} team={null} teamView={false} playoffAlliances={[]} eventTimezone={event.timezone} eventPlayoffType={event.playoff_type} nextMatchKey={null}/>
          </div>

          <div className="flex flex-col gap-2">
            <button className="bg-neutral-800 w-full hover:bg-zinc-800 rounded p-2" onClick={()=> router.push(`/gameday/${event.key}`)}>Watch {hasDivisions ? "Event" : "Now"}</button>
            { hasDivisions ? 
            (<button className="bg-neutral-800 w-full hover:bg-zinc-800 rounded p-2" onClick={()=> router.push(`/gameday/divisional-event/${event.key}`)}>Watch Divisions</button>) : 
            (
              <button onClick={() => toggleEvent(event.key)} className={`w-full rounded p-2 ${selected ? "bg-blue-600 text-white" : "bg-neutral-800  hover:bg-zinc-800"}`}>
                Add to Multiview
              </button>
            )}
          </div>

        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold">Gameday Event Selector</h1>
            <p>Select event(s) below. </p>
          </div>

          <button
            onClick={startGameday}
            disabled={selectedEvents.size === 0}
            className="px-4 py-2 rounded bg-blue-600 disabled:opacity-40"
          >
            Start Multiview ({selectedEvents.size})
          </button>
        </div>

        {loading && <div className="opacity-70">Loading events...</div>}

        {!loading && (
          <div className="space-y-8">
            <Section title="In Progress Events">
              {grouped.in_progress?.map(e => (
                <EventCard key={e.key} event={e} />
              ))}
            </Section>

            <Section title="Upcoming Events">
              {grouped.upcoming?.map(e => (
                <EventCard key={e.key} event={e} />
              ))}
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: any) {
  return (
    <div>
      <h2 className="text-lg font-semibold mb-2">{title} <span className="opacity-80 text-sm">({children.length})</span></h2>
      <div className="space-y-2 gap-2">{children}</div>
    </div>
  );
}