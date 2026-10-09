"use client";

import { useEffect, useRef, useState } from "react";
import type { StatboticsMatch } from "./types";

export type StatboticsMatchState = {
  data: StatboticsMatch | null;
  status: "loading" | "ready" | "unavailable";
};

const RESULT_REFRESH_DELAY_MS = 90_000;

export function useStatboticsMatch(
  matchKey: string | null | undefined,
  resultSignature?: string | null,
): StatboticsMatchState {
  const [state, setState] = useState<StatboticsMatchState>({
    data: null,
    status: "loading",
  });
  const previousResult = useRef<{
    matchKey: string | null;
    signature: string | null;
  }>({ matchKey: null, signature: null });

  useEffect(() => {
    if (!matchKey) {
      setState({ data: null, status: "unavailable" });
      return;
    }

    const abort = new AbortController();
    let active = true;
    setState({ data: null, status: "loading" });

    fetch("/api/statbotics/match/" + encodeURIComponent(matchKey), {
      cache: "no-store",
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Statbotics match unavailable");
        return await response.json() as StatboticsMatch;
      })
      .then((data) => {
        if (active) setState({ data, status: "ready" });
      })
      .catch(() => {
        if (active && !abort.signal.aborted) {
          setState({ data: null, status: "unavailable" });
        }
      });

    return () => {
      active = false;
      abort.abort();
    };
  }, [matchKey]);

  useEffect(() => {
    const previous = previousResult.current;
    previousResult.current = {
      matchKey: matchKey ?? null,
      signature: resultSignature ?? null,
    };

    if (
      !matchKey ||
      !resultSignature?.startsWith("final:") ||
      previous.matchKey !== matchKey ||
      !previous.signature ||
      previous.signature === resultSignature
    ) {
      return;
    }

    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(
        "/api/statbotics/match/" + encodeURIComponent(matchKey) + "?refresh=1",
        { cache: "no-store", signal: abort.signal },
      )
        .then(async (response) => {
          if (!response.ok) throw new Error("Statbotics refresh unavailable");
          return await response.json() as StatboticsMatch;
        })
        .then((data) => {
          if (!abort.signal.aborted) setState({ data, status: "ready" });
        })
        .catch(() => {
          // Keep the last usable prediction if a refresh fails.
        });
    }, RESULT_REFRESH_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [matchKey, resultSignature]);

  return state;
}
