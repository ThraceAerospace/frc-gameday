"use client";

import { useEffect, useState } from "react";

type SidebarEvent = { id: string; key: string; name: string };

export default function TeamEventsSidebar({ events }: { events: SidebarEvent[] }) {
  const [activeEventId, setActiveEventId] = useState(events[0]?.id ?? "");

  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-scroll-container]");
    const sections = events.map(({ id }) => document.getElementById(id)).filter((section): section is HTMLElement => section !== null);
    if (!sections.length) return;

    const updateActive = () => {
      const rootTop = root?.getBoundingClientRect().top ?? 0;
      const line = rootTop + (root?.clientHeight ?? window.innerHeight) * 0.3;
      const current = [...sections].reverse().find((section) => section.getBoundingClientRect().top <= line);
      if (current) setActiveEventId(current.id);
    };

    const observer = new IntersectionObserver(updateActive, { root, rootMargin: "-5% 0px -75% 0px", threshold: 0 });
    sections.forEach((section) => observer.observe(section));
    updateActive();
    return () => observer.disconnect();
  }, [events]);

  if (!events.length) return null;
  return (
    <aside className="min-w-0 lg:sticky lg:top-5 lg:self-start">
      <p className="mb-2 hidden px-2 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400 lg:block">Events attended</p>
      <nav aria-label="Team events" className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-2 lg:block lg:space-y-1">
        {events.map((event) => {
          const active = activeEventId === event.id;
          return (
            <a key={event.key} href={`#${event.id}`} aria-current={active ? "location" : undefined} onClick={() => setActiveEventId(event.id)} className={`block min-w-max rounded-lg px-3 py-2 text-sm font-medium transition-colors lg:min-w-0 ${active ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"}`}>
              <span className="block truncate lg:whitespace-normal">{event.name}</span>
              <span className={`mt-0.5 block font-mono text-[10px] ${active ? "text-blue-500" : "text-slate-400"}`}>{event.key}</span>
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
