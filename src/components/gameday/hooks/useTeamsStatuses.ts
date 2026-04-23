"use client";

import { useEffect, useState } from "react";

export function useTeamsStatuses(eventKey: string) {
  const [teamsStatuses, setTeams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!eventKey) return;

    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/event/${eventKey}/teams/statuses`);
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

  return { teamsStatuses, loading };
}