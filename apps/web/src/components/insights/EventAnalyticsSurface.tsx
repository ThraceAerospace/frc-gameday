"use client";

import {
  useCanonicalEventAnalytics,
  useCanonicalEventSnapshot,
  useCanonicalRuntimeStatus,
} from "@/lib/events";
import type { FieldViewEventSnapshot } from "@fieldview/domain";
import EventAnalyticsDashboard from "./EventAnalyticsDashboard";

export default function EventAnalyticsSurface({
  eventKey,
  eventName,
  initialSnapshot,
}: {
  eventKey: string;
  eventName: string;
  initialSnapshot: FieldViewEventSnapshot;
}) {
  const liveSnapshot = useCanonicalEventSnapshot(eventKey);
  const analyticsPublication = useCanonicalEventAnalytics(eventKey);
  const websocketStatus = useCanonicalRuntimeStatus(eventKey);

  return (
    <EventAnalyticsDashboard
      eventKey={eventKey}
      eventName={eventName}
      eventState={liveSnapshot?.snapshot ?? initialSnapshot}
      analyticsPublication={analyticsPublication}
      websocketStatus={websocketStatus}
      websocketStale={false}
    />
  );
}
