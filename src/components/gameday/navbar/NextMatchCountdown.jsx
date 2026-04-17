"use client";

import { useEffect, useState } from "react";

function getEventNow(timezone) {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: timezone })
  );
}

function formatTimeRemaining(seconds) {
  if (seconds <= 0) return "Now";

  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;

  if (mins > 60) {
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hrs.toString().padStart(2, '0')}h ${remMins.toString().padStart(2, '0')}m`;
  }

  return `${mins.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
}

export default function NextMatchCountdown({
  nextMatch,
  timezone,
}) {
  const [remaining, setRemaining] = useState(null);

  useEffect(() => {
    if (!nextMatch?.predicted_time) {
      setRemaining(null);
      return;
    }

    const update = () => {
      const now = getEventNow(timezone);
      const target = new Date(nextMatch.predicted_time * 1000);

      const diff = Math.floor((target - now) / 1000);
      setRemaining(diff);
    };

    update();
    const id = setInterval(update, 1000);

    return () => clearInterval(id);
  }, [nextMatch, timezone]);

  if (!nextMatch) {
    return (
      <div className="text-sm text-gray-400">
        No upcoming match
      </div>
    );
  }

  const formatted = formatTimeRemaining(remaining);

  return (
    <div className="text-sm">
      <span className="font-mono font-semibold text-white">
        {formatted}
      </span>
    </div>
  );
}