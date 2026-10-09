"use client";

import { useEffect, useRef, useState } from "react";
import type { StatboticsMatch } from "./types";

export type StatboticsMatchState = {
  data: StatboticsMatch | null;
  status: "loading" | "ready" | "unavailable";
};

const RESULT_REFRESH_DELAY_MS = 3 * 60 * 1000;

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
  const resultSignatureRef = useRef(resultSignature);

  useEffect(() => {
    resultSignatureRef.current = resultSignature;
  }, [resultSignature]);

  useEffect(() => {
    if (!matchKey) {
      setState({ data: null, status: "unavailable" });
      return;
    }

    const abort = new AbortController();
    let active = true;
    setState({ data: null, status: "loading" });

    // A match already known to be final is an on-demand historical lookup;
    // ask the shared service to refresh its cached record once, subject to its
    // distributed refresh cooldown. Live transitions are handled by the delay below.
    const refreshOnLoad = resultSignatureRef.current?.startsWith("final:") === true;
    const endpoint = "/api/statbotics/match/" + encodeURIComponent(matchKey) +
      (refreshOnLoad ? "?refresh=1" : "");

    fetch(endpoint, {
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
