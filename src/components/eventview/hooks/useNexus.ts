"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NexusData } from "@/lib/nexus/types";
import { usePolling } from "./usePolling";

export function useNexus(eventKey: string | null) {
  const [data, setData] = useState<NexusData | null>(null);
  const [loading, setLoading] = useState(Boolean(eventKey));
  const [error, setError] = useState<Error | null>(null);
  const etag = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!eventKey) return;
    try {
      const res = await fetch(`/api/event/${eventKey}/nexus`, {
        cache: "no-store",
        headers: etag.current ? { "If-None-Match": etag.current } : undefined,
      });
      if (res.status === 204 || res.status === 304) return;
      if (!res.ok) throw new Error(`Nexus request failed: ${res.status}`);
      etag.current = res.headers.get("etag");
      setData(await res.json());
      setError(null);
    } catch (error) { setError(error instanceof Error ? error : new Error("Nexus request failed")); }
    finally { setLoading(false); }
  }, [eventKey]);

  const refresh = usePolling(load, "realtime", { enabled: Boolean(eventKey), resetKey: eventKey });
  useEffect(() => { etag.current = null; setData(null); setError(null); setLoading(Boolean(eventKey)); }, [eventKey]);
  return { data, loading, error, refresh };
}
