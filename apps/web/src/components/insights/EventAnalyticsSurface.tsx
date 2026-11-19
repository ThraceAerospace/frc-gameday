"use client";

import { useCanonicalRuntimeStatus } from "@/lib/events";
import EventAnalyticsDashboard from "./EventAnalyticsDashboard";

export default function EventAnalyticsSurface({
  eventKey,
  eventName,
}: {
  eventKey: string;
  eventName: string;
}) {
  const websocketStatus = useCanonicalRuntimeStatus(eventKey);


  return (
    <EventAnalyticsDashboard
      eventKey={eventKey}
      eventName={eventName}
      websocketStatus={websocketStatus}
      websocketStale={false}
    />
  );
}
