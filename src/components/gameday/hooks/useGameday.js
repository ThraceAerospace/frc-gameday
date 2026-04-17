"use client";

import { useEffect, useState, useCallback } from "react";

export function useGameday(event, team) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!event) {
      console.log("Skipping fetch, no event yet");
      return;
    }

    try {
      setLoading(true);

      const url = team
        ? `/api/event/${event}/gameday?team=${team}`
        : `/api/event/${event}/gameday`;

      console.log("FETCHING:", url);

      const res = await fetch(url, {
                    next: { revalidate: 0 },
                  });
      const json = await res.json();

      setData(json);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [event, team]);

  useEffect(() => {
    if (!event) return;

    let cancelled = false;
    let interval;

    async function fetchData() {
      console.log("Fetching gameday data for event:", event, "team:", team);
      try {
        const url = team
          ? `/api/event/${event}/gameday?team=${team}`
          : `/api/event/${event}/gameday`;

        const res = await fetch(url);
        const json = await res.json();

        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    // initial load
    fetchData();

    // polling
    interval = setInterval(fetchData, 150000); // 2.5 minutes

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [event, team]);

  return { data, loading, error, reload: load };
}