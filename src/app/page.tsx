"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDaysIcon,
  ChevronRightIcon,
  MagnifyingGlassIcon,
  Squares2X2Icon,
  TvIcon,
} from "@heroicons/react/24/outline";
import { dumbDateString } from "@/lib/time/index";

type EventFlags = {
  hasDivisions?: boolean;
};

type EventData = {
  key: string;
  name?: string;
  short_name?: string;
  city?: string;
  state_prov?: string;
  country?: string;
  start_date?: string;
  end_date?: string;
  event_type_string?: string;
  state?: "in_progress" | "upcoming" | string;
  flags?: EventFlags;
};

type EventSectionProps = {
  title: string;
  icon: React.ReactNode;
  events: EventData[];
  selected: string[];
  toggle: (key: string) => void;
  router: ReturnType<typeof useRouter>;
  live?: boolean;
};

type EventCardProps = {
  event: EventData;
  selected: boolean;
  toggle: (key: string) => void;
  router: ReturnType<typeof useRouter>;
  live: boolean;
};

export default function HomePage() {
  const router = useRouter();

  const [events, setEvents] = useState<EventData[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/events/active", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) {
          throw new Error();
        }

        return res.json();
      })
      .then((data: unknown) => {
        if (cancelled) {
          return;
        }

        setEvents(Array.isArray(data) ? (data as EventData[]) : []);
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    if (!q) {
      return events;
    }

    return events.filter((event) =>
      [
        event.name,
        event.short_name,
        event.city,
        event.state_prov,
        event.country,
        event.key,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [events, query]);

  const groups = useMemo(
    () => ({
      in_progress: filtered.filter((event) => event.state === "in_progress"),
      upcoming: filtered.filter((event) => event.state === "upcoming"),
    }),
    [filtered]
  );

  function toggle(key: string) {
    setSelected((current) =>
      current.includes(key)
        ? current.filter((k) => k !== key)
        : [...current, key]
    );
  }

  function openMultiview() {
    router.push(
      `/gameday?${selected
        .map((key) => `event=${encodeURIComponent(key)}`)
        .join("&")}`
    );
  }

  return (
    <main className="min-h-screen bg-black text-white">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-black/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 lg:px-6">
          <div className="min-w-0 flex-1">
            <div className="text-lg font-bold tracking-tight">FieldView</div>

            <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
              FIRST Robotics live events
            </div>
          </div>

          {selected.length > 0 && (
            <button
              onClick={openMultiview}
              className="hidden items-center gap-2 rounded-lg bg-white px-3 py-2 text-xs font-bold text-black sm:flex"
            >
              <Squares2X2Icon className="h-4 w-4 shrink-0" />
              Open multiview · {selected.length}
            </button>
          )}
        </div>

        <div className="mx-auto max-w-7xl px-4 pb-3 lg:px-6">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />

            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search events, cities, teams…"
              className="w-full rounded-xl border border-white/10 bg-white/5 py-2.5 pl-9 pr-3 text-sm outline-none placeholder:text-neutral-600 focus:border-white/25"
            />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
        {loading && (
          <div className="py-20 text-center text-sm text-neutral-500">
            Loading current events…
          </div>
        )}

        {error && (
          <div className="py-20 text-center">
            <div className="font-semibold">Events could not be loaded.</div>

            <div className="mt-2 text-sm text-neutral-500">
              Try refreshing the page.
            </div>
          </div>
        )}

        {!loading && !error && (
          <div className="space-y-10">
            <EventSection
              title="Live now"
              icon={<TvIcon className="h-4 w-4 shrink-0" />}
              events={groups.in_progress}
              selected={selected}
              toggle={toggle}
              router={router}
              live
            />

            <EventSection
              title="Upcoming"
              icon={<CalendarDaysIcon className="h-4 w-4 shrink-0" />}
              events={groups.upcoming}
              selected={selected}
              toggle={toggle}
              router={router}
            />

            {!groups.in_progress.length && !groups.upcoming.length && (
              <div className="py-20 text-center text-sm text-neutral-500">
                No matching events.
              </div>
            )}
          </div>
        )}
      </div>

      {selected.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-neutral-950/95 p-3 backdrop-blur sm:hidden">
          <button
            onClick={openMultiview}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-white py-3 text-sm font-bold text-black"
          >
            <Squares2X2Icon className="h-4 w-4 shrink-0" />

            Open {selected.length} selected event
            {selected.length === 1 ? "" : "s"}
          </button>
        </div>
      )}
    </main>
  );
}

function EventSection({
  title,
  icon,
  events,
  selected,
  toggle,
  router,
  live = false,
}: EventSectionProps) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {icon}
        </span>

        <h2 className="text-sm font-bold uppercase tracking-widest">
          {title}
        </h2>

        <span className="text-xs text-neutral-600">{events.length}</span>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {events.map((event) => (
          <EventCard
            key={event.key}
            event={event}
            selected={selected.includes(event.key)}
            toggle={toggle}
            router={router}
            live={live}
          />
        ))}
      </div>
    </section>
  );
}

function EventCard({
  event,
  selected,
  toggle,
  router,
  live,
}: EventCardProps) {
  const hasDivisions = !!event.flags?.hasDivisions;

  const name = (
    event.short_name ||
    event.name ||
    event.key
  ).replace("- FIRST Robotics Competition", "");

  return (
    <article
      className={`group rounded-2xl border p-4 transition ${
        live
          ? "border-white/20 bg-white/[0.07]"
          : "border-white/10 bg-white/[0.03] hover:bg-white/[0.05]"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {live && (
              <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
            )}

            <h3 className="truncate font-semibold">{name}</h3>
          </div>

          <p className="mt-1 text-xs text-neutral-500">
            {event.city}
            {event.state_prov ? `, ${event.state_prov}` : ""}
            {" · "}
            {event.country}
          </p>

          <p className="mt-1 text-[11px] text-neutral-600">
            {event.start_date ? dumbDateString(event.start_date) : ""}
            {event.end_date
              ? ` – ${dumbDateString(event.end_date)}`
              : ""}
          </p>
        </div>

        <span className="shrink-0 rounded-md bg-white/5 px-2 py-1 text-[9px] uppercase tracking-wider text-neutral-500">
          {event.event_type_string || "Event"}
        </span>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          onClick={() => router.push(`/gameday?event=${event.key}`)}
          className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-white px-3 py-2 text-xs font-bold text-black hover:bg-neutral-200"
        >
          Watch

          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0" />
        </button>

        {hasDivisions ? (
          <button
            onClick={() =>
              router.push(`/gameday/divisional-event/${event.key}`)
            }
            className="rounded-lg border border-white/10 px-3 py-2 text-xs hover:bg-white/5"
          >
            Divisions
          </button>
        ) : (
          <button
            onClick={() => toggle(event.key)}
            className={`rounded-lg border px-3 py-2 text-xs ${
              selected
                ? "border-white bg-white text-black"
                : "border-white/10 hover:bg-white/5"
            }`}
          >
            {selected ? "Selected" : "Multiview"}
          </button>
        )}
      </div>
    </article>
  );
}