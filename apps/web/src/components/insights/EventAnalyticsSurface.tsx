"use client";

import { useCanonicalEventSnapshot, useCanonicalRuntimeStatus } from "@/lib/events";
import EventAnalyticsDashboard from "./EventAnalyticsDashboard";

export default function EventAnalyticsSurface({
  eventKey,
  eventName,
}: {
  eventKey: string;
  eventName: string;
}) {
  const canonical = useCanonicalEventSnapshot(eventKey);
  const websocketStatus = useCanonicalRuntimeStatus(eventKey);
  const snapshot = canonical?.snapshot;

  return (
    <EventAnalyticsDashboard
      eventKey={eventKey}
      eventName={eventName}
      analytics={snapshot?.analytics}
      teamStates={snapshot?.team_states}
      matches={snapshot?.matches}
      loading={canonical === undefined}
      websocketStatus={websocketStatus}
    />
  );
}
