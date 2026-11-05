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
  const liveMatch = snapshot.eventLastMatch;
  const liveMatchKey = liveMatch?.key ?? null;
  const liveStatbotics = liveMatchKey ? snapshot.statboticsMatches[liveMatchKey] : undefined;
  const liveMatchSignature = liveMatch
    ? `${liveMatch.key}:${liveMatch.alliances.red.score}:${liveMatch.alliances.blue.score}:${liveMatch.actual_time ?? ""}:${liveStatbotics?.status ?? "missing"}:${JSON.stringify(liveStatbotics?.data ?? null)}`
    : "";

  return (
    <EventAnalyticsDashboard
      eventKey={eventKey}
      eventName={eventName}
      liveMatchKey={liveMatchKey}
      liveMatchSignature={liveMatchSignature}
      websocketStatus={snapshot.websocketStatus}
      websocketStale={snapshot.websocketStale}
    />
  );
}
