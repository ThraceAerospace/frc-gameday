"use client";

import { use } from "react";
import EventDataPanel from "@/components/eventdata/EventDataPanel";

export default function EventDataPage({
  params,
}: {
  params: Promise<{ event: string }>;
}) {
  const { event } = use(params);

  return (
    <main className="h-screen bg-black p-3 text-white sm:p-5">
      <EventDataPanel eventKey={event} />
    </main>
  );
}
