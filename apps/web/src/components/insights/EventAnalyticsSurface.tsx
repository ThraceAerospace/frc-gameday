"use client";

import {
  useCanonicalEventAnalytics,
  useCanonicalEventSnapshot,
  useCanonicalRuntimeStatus,
} from "@/lib/events";
import type { FieldViewEventState } from "@fieldview/domain";
import EventAnalyticsDashboard from "./EventAnalyticsDashboard";

export default function EventAnalyticsSurface({
  eventKey,
  eventName,
  initialSnapshot,
}: {
  eventKey: string;
  eventName: string;
  initialSnapshot: FieldViewEventState;
}) {
  const liveSnapshot = useCanonicalEventSnapshot(eventKey);
  const analyticsPublication = useCanonicalEventAnalytics(eventKey);
  const websocketStatus = useCanonicalRuntimeStatus(eventKey);

  return (
    <EventAnalyticsDashboard
      eventKey={eventKey}
      eventName={eventName}
      eventState={liveSnapshot?.snapshot.state ?? initialSnapshot}
      teamStates={liveSnapshot?.snapshot.team_states ?? []}
      analyticsPublication={analyticsPublication}
      websocketStatus={websocketStatus}
      websocketStale={false}
    />
  );
}
