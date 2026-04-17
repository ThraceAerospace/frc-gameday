"use client";

import { useEffect, useState } from "react";

function getNow() {
  return new Date();
}

export default function EventLocalTime({ timezone }) {
  const [now, setNow] = useState(() => getNow());

  useEffect(() => {
    const id = setInterval(() => {
      setNow(getNow());
    }, 1000);

    return () => clearInterval(id);
  }, [timezone]);

  return (
    <div className="text-xs text-gray-300">
      <span className="font-mono">
        {now.toLocaleTimeString("en-US", {
          timeZone: timezone,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          timeZoneName: "short",
        })}
      </span>
    </div>
  );
}