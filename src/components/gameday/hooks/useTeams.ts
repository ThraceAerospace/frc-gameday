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
        //console.log(json);
        await Promise.all(json.map(async (t: any) => {
          const district = await fetch(`/api/team/${t.key}/district`).then(res => res.json());
          t.district = district || null;
        }));


        if (!cancelled) {
          setTeams(json);
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