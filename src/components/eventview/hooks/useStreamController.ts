"use client";

import { useEffect, useMemo, useState } from "react";
import type { BuiltStream } from "@/lib/tba/buildStreams";

type InputStream = BuiltStream & { key?: string };
type ResolvedStream = {
  key: string;
  type: string;
  channel: string;
  url: string;
  date?: string | null;
  meta?: { title?: string | null } | null;
};

function streamKey(stream: InputStream) { return stream.key ?? `${stream.type}:${stream.channel}:${stream.date ?? ""}`; }
function today(timezone: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }

export function useStreamController(input: InputStream[] = [], timezone?: string | null, preferredKey?: string | null) {
  const streams = useMemo<ResolvedStream[]>(() => {
    const available: ResolvedStream[] = input
      .filter((s) => s?.type && s?.channel)
      .map((s) => ({ ...s, key: streamKey(s) }));

    if (preferredKey?.startsWith("custom:")) {
      const url = preferredKey.slice("custom:".length);
      try {
        const parsed = new URL(url);
        if (
          (parsed.protocol === "https:" || parsed.protocol === "http:") &&
          !available.some((stream) => stream.key === preferredKey)
        ) {
          available.push({
            type: "custom",
            channel: parsed.toString(),
            url: parsed.toString(),
            date: null,
            meta: { title: "Custom stream URL" },
            key: preferredKey,
          });
        }
      } catch {
        // Ignore malformed custom selections rather than rendering an unsafe URL.
      }
    }
    return available;
  }, [input, preferredKey]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const map = useMemo(() => new Map(streams.map((stream) => [stream.key, stream])), [streams]);

  useEffect(() => {
    setActiveKey((current) => {
      if (preferredKey && map.has(preferredKey)) return preferredKey;
      if (current && map.has(current)) return current;
      if (!streams.length) return null;
      if (!timezone) return streams[0]?.key ?? null;
      const now = today(timezone);
      const ordered = [...streams].sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
      return ([...ordered].reverse().find((s) => String(s.date ?? "") <= now) ?? ordered[0])?.key ?? null;
    });
  }, [map, streams, timezone, preferredKey]);

  return { streams, activeKey, activeStream: activeKey ? map.get(activeKey) ?? null : null, setActiveKey };
}
