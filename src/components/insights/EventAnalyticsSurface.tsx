"use client";

import { useEventState } from "@/lib/events";
import EventAnalyticsDashboard from "./EventAnalyticsDashboard";

export default function EventAnalyticsSurface({
  eventKey,
  eventName,
}: {
  eventKey: string;
  eventName: string;
}) {
  const snapshot = useEventState(eventKey);
  const liveMatchKey = snapshot.eventLastMatch?.key ?? null;

  return (
    <EventAnalyticsDashboard
      eventKey={eventKey}
      eventName={eventName}
      liveMatchKey={liveMatchKey}
      websocketStatus={snapshot.websocketStatus}
      websocketStale={snapshot.websocketStale}
    />
  );
}
