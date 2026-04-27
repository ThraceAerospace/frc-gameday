"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Build a stable unique key for a stream
 */
function makeKey(stream) {
  return (
    stream.key ||
    `${stream.type}:${stream.channel}:${stream.date}`
  );
}

/**
 * Get YYYY-MM-DD in event timezone
 */
function getTodayInTimezone(timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Pick default stream deterministically
 */
function pickDefaultStream(streams, timezone) {
  if (!streams?.length || !timezone) return null;
  const sorted = [...streams].sort((a, b) => new Date(a.date) - new Date(b.date));
  
  const result =
    sorted.find((s) => new Date(s.date) <= today) ||
    sorted.find((s) => new Date(s.date) > today) ||
    sorted[sorted.length - 1] ||
    null;
}

export function useStreamController(streams = [], timezone) {
  /**
   * Normalize streams ONCE per change
   * (no ordering assumptions outside this block)
   */
  const normalized = useMemo(() => {
    if (!Array.isArray(streams)) return [];

    return streams
      .filter((s) => s?.channel && s?.type)
      .map((s) => ({
        ...s,
        key: makeKey(s),
      }));
  }, [streams]);

  /**
   * Build a stable lookup map (CRITICAL FIX)
   */
  const streamMap = useMemo(() => {
    const map = new Map();
    for (const s of normalized) {
      map.set(s.key, s);
    }
    return map;
  }, [normalized]);

  /**
   * Active stream key (source of truth)
   */
  const [activeKey, setActiveKey] = useState(null);

  /**
   * Initialize default ONLY ONCE per stream set
   * (never re-run due to ordering changes)
   */
  useEffect(() => {
    if (!normalized.length || !timezone) return;

    setActiveKey((prev) => {
      if (prev) return prev; // user override always wins

      const defaultStream = pickDefaultStream(normalized, timezone);
      return defaultStream?.key || null;
    });
  }, [normalized, timezone]);

  /**
   * Resolve active stream strictly by key
   * (NO ARRAY INDEX FALLBACK — THIS WAS THE BUG)
   */
  const activeStream = useMemo(() => {
    if (!activeKey) return null;
    return streamMap.get(activeKey) || null;
  }, [streamMap, activeKey]);

  /**
   * Optional derived list (safe for UI, NOT logic)
   */
  const streamsList = useMemo(() => normalized, [normalized]);

  return {
    streams: streamsList,
    activeStream,
    activeKey,
    setActiveKey,
  };
}
