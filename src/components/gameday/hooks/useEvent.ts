"use client";

import { useEffect, useState } from "react";

export function useEvent(eventKey:string) {
  const [event, setEvent] = useState(null);

  useEffect(() => {
    if (!eventKey) return;

    let cancelled = false;

    async function load() {
      console.log("FETCH EVENT:", eventKey);
      try {
        const res = await fetch(`/api/event/${eventKey}`);

        if (!res.ok) throw new Error("Event fetch failed");

        const json = await res.json();

        if (cancelled) return;

        setEvent(json ?? null);
      } catch (err) {
        console.error("useEvent error:", err);
        setEvent(null);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [eventKey]);

  return { event };
}