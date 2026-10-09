"use client";

import { use } from "react";
import MatchInsightsView from "@/components/match/MatchInsightsView";

export default function MatchInsightsPage({
  params,
}: {
  params: Promise<{ event: string }>;
}) {
  const { event } = use(params);

  return (
    <main className="h-screen overflow-hidden bg-black text-white">
      <MatchInsightsView eventKey={event} />
    </main>
  );
}
