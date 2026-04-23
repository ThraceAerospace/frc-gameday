"use client";

import { useEffect, useState } from "react";

export function useTeams(eventKey: string) {
  const [teams, setTeams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!eventKey) return;

    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/event/${eventKey}/teams`);
        const json = await res.json();

        if (!cancelled) {
          setTeams(json.teams ?? json);
          setLoading(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [eventKey]);

  return { teams, loading };
}