"use client";

import { useEffect, useMemo, useState } from "react";
import type { BuiltStream } from "@/lib/gameday/buildStreams";

type Stream = BuiltStream & { key?: string };

function streamKey(stream: Stream) { return stream.key ?? `${stream.type}:${stream.channel}:${stream.date ?? ""}`; }
function today(timezone: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }

export function useStreamController(input: Stream[] = [], timezone?: string) {
  const streams = useMemo(() => input.filter((s) => s?.type && s?.channel).map((s) => ({ ...s, key: streamKey(s) })), [input]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const map = useMemo(() => new Map(streams.map((stream) => [stream.key!, stream])), [streams]);

  useEffect(() => {
    if (!streams.length || !timezone) return;
    setActiveKey((current) => {
      if (current && map.has(current)) return current;
      const now = today(timezone);
      const ordered = [...streams].sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
      return ([...ordered].reverse().find((s) => String(s.date ?? "") <= now) ?? ordered[0])?.key ?? null;
    });
  }, [map, streams, timezone]);

  return { streams, activeKey, activeStream: activeKey ? map.get(activeKey) ?? null : null, setActiveKey };
}
