"use client";

import { useSharedSecondClock } from "@/lib/time/sharedSecondClock";

export default function EventLocalTime({ timezone }: { timezone?: string | null }) {
  const now = useSharedSecondClock();

  if (!timezone) return null;

  return (
    <span className="font-mono text-sm tabular-nums text-neutral-500 text-[10px]">
      {new Date(now).toLocaleTimeString("en-US", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short",
      })}
    </span>
  );
}