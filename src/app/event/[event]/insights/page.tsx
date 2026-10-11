"use client";

import { use } from "react";
import EventInsightsSurface from "@/components/surface/EventInsightsSurface";

export default function MatchInsightsPage({
  params,
}: {
  params: Promise<{ event: string }>;
}) {
  const { event } = use(params);
  return <EventInsightsSurface eventKey={event} />;
}
