"use client";

import { useEffect, useState } from "react";

export default function EventLocalTime({ timezone }: { timezone?: string | null }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => {
      setNow(new Date());
    }, 1000);

    return () => clearInterval(id);
  }, []);

  if (!timezone) return null;

  return (
    <span className="font-mono text-sm tabular-nums text-neutral-500 text-[10px]">
      {now.toLocaleTimeString("en-US", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
        timeZoneName: "short",
      })}
    </span>
  );
}