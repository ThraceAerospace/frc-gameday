"use client";

import { useEffect, useState } from "react";
import type { TBATeam } from "@/lib/tba/types";

export function useTeams(eventKey: string) {
  const [teams, setTeams] = useState<TBATeam[]>([]);
  const [loading, setLoading] = useState(Boolean(eventKey));

  useEffect(() => {
    if (!eventKey) { setTeams([]); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/event/${eventKey}/teams`, { cache: "no-store", signal: controller.signal })
      .then((res) => { if (!res.ok) throw new Error(`Teams request failed: ${res.status}`); return res.json(); })
      .then((data) => setTeams(Array.isArray(data) ? (data as TBATeam[]) : []))
      .catch((err) => { if (err.name !== "AbortError") { console.error("useTeams:", err); setTeams([]); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [eventKey]);

  return { teams, loading };
}
