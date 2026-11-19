"use client";

import { useEffect } from "react";
import { useCanonicalEventSnapshot } from "@/lib/events";
import type { FieldViewMatch } from "@fieldview/domain";
import EventInsightView from "@/components/match/EventInsightView";

type EventInsightsSurfaceProps = {
  eventKey: string;
  trackedTeams?: string[];
  matchOverride?: FieldViewMatch | null;
  onClose?: () => void;
  embedded?: boolean;
};

/**
 * Hosts the Insights View for exactly one event.
 *
 * The caller chooses the event key: Tile View's shared active selection for
 * an integrated display, or the URL event for the standalone route. The
 * shared EventState remains the sole owner of live data acquisition.
 */
export default function EventInsightsSurface({
  eventKey,
  trackedTeams = [],
  matchOverride = null,
  onClose,
  embedded = false,
}: EventInsightsSurfaceProps) {
  const canonical = useCanonicalEventSnapshot(eventKey);
  const snapshot = canonical?.snapshot;

  useEffect(() => {
    if (!onClose) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className={`${embedded ? "h-full" : "h-screen"} overflow-hidden bg-black text-white`}>
      <EventInsightView
        eventKey={eventKey}
        snapshot={snapshot}
        trackedTeams={trackedTeams}
        matchOverride={matchOverride}
      />
    </div>
  );
}
