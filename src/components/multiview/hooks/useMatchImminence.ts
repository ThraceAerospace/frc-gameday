"use client";

import { useEffect } from "react";

export function useMatchImminence(match: any, emit: (signal: any) => void) {
  useEffect(() => {
    if (!match?.predicted_time) return;

    const update = () => {
      const now = Date.now();
      const matchTime = match.predicted_time * 1000;

      const diff = matchTime - now;

      const isImminent = diff <= 2 * 60 * 1000 && diff > -60 * 1000;

      if (isImminent) {
        emit({
          type: "match_imminent",
          matchKey: match.key,
          severity: diff <= 60 * 1000 ? "hard" : "soft",
        });
      }
    };

    update();
    const interval = setInterval(update, 10000);

    return () => clearInterval(interval);
  }, [match?.key]);
}