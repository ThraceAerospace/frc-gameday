"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Stable key for stream identity
 */
function makeKey(stream) {
  return stream.key || `${stream.type}:${stream.channel}:${stream.date}`;
}

/**
 * Returns YYYY-MM-DD in event timezone
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
 * Select best default stream:
 * 1. match today's date in event timezone
 * 2. fallback to first stream
 */
function pickDefaultStream(streams, timezone) {
  if (!streams?.length || !timezone) return null;

  const today = getTodayInTimezone(timezone);

  const match = streams.find((s) => s.date === today);

  return match || streams[0];
}

export function useStreamController(streams = [], timezone) {
  /**
   * Normalize ONCE
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

  const [activeKey, setActiveKey] = useState(null);

  /**
   * Initialize default stream
   * (timezone REQUIRED to avoid incorrect selection)
   */
  useEffect(() => {
    if (!normalized.length || !timezone) return;

    setActiveKey((prev) => {
      if (prev) return prev; // respect user selection

      const defaultStream = pickDefaultStream(normalized, timezone);

      return defaultStream?.key || null;
    });
  }, [normalized, timezone]);

  /**
   * Derived active stream (always consistent)
   */
  const activeStream = useMemo(() => {
    if (!normalized.length) return null;

    return (
      normalized.find((s) => s.key === activeKey) ||
      normalized[0] ||
      null
    );
  }, [normalized, activeKey]);

  return {
    streams: normalized,
    activeStream,
    activeKey,
    setActiveKey,
  };
}