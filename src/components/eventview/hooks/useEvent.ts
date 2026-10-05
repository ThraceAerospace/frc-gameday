"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TBAEvent } from "@/lib/tba/types";

export function useEvent(eventKey: string) {
  const [event, setEvent] = useState<TBAEvent | null>(null);
  const [loading, setLoading] = useState(Boolean(eventKey));
  const [error, setError] = useState<Error | null>(null);

  const controllerRef = useRef<AbortController | null>(null);

  const reloadEvent = useCallback(async () => {
    if (!eventKey) {
      setEvent(null);
      setLoading(false);
      setError(null);
      return;
    }

    controllerRef.current?.abort();

    const controller = new AbortController();
    controllerRef.current = controller;

    setLoading(true);
    setError(null);
    setEvent(null);

    try {
      const res = await fetch(`/api/event/${eventKey}`, {
        cache: "no-store",
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Event request failed: ${res.status}`);
      }

      const data = (await res.json()) as TBAEvent;

      if (!controller.signal.aborted) {
        setEvent(data);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(
          err instanceof Error
            ? err
            : new Error("Event request failed"),
        );
        setEvent(null);
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [eventKey]);

  useEffect(() => {
    void reloadEvent();

    return () => {
      controllerRef.current?.abort();
    };
  }, [reloadEvent]);

  return {
    event,
    loading,
    error,
    reloadEvent,
  };
}