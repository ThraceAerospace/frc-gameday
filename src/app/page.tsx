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

    return (
      <div className="gap-2 rounded"> 
        <button
          onClick={() => toggleEvent(event.key)}
          className={`w-full text-left p-3 rounded-lg transition
            ${selected ? "bg-blue-600 text-white" : "bg-zinc-900 hover:bg-zinc-800"}`}
        >
          <div className="flex justify-between items-center">
            <div>
              <div className="font-semibold">{event.name}</div>
              <div><span className="text-xs opacity-70">{event.event_type_string}</span></div>
              <div><span className="text-xs">{dumbDateString(event.start_date)} - {dumbDateString(event.end_date)}</span></div>
            </div>
            <div className="flex ">
              <MatchStrip matches={event.matches} team={null} teamView={false} playoffAlliances={[]} eventTimezone={event.timezone} eventPlayoffType={event.playoff_type} nextMatchKey={null}/>
            </div>
            <div className="text-xs px-2 py-1 rounded bg-black/30">
              {event.state || "upcoming"}
            </div>
          </div>
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold">Gameday Selector</h1>

          <button
            onClick={startGameday}
            disabled={selectedEvents.size === 0}
            className="px-4 py-2 rounded bg-blue-600 disabled:opacity-40"
          >
            Start ({selectedEvents.size})
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