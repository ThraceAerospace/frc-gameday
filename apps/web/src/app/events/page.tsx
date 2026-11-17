import { normalizeFieldViewEvent } from "@fieldview/domain";
import { TBA } from "@/lib/tba/service";
import { getCanonicalEventDiscovery } from "@/lib/events/serverSnapshot";
import EventsBrowser from "./EventsBrowser";

export default async function EventsPage() {
  const year = new Date().getUTCFullYear();
  const canonicalEvents = await getCanonicalEventDiscovery(year);
  const retrievedAt = new Date().toISOString();
  const events = canonicalEvents ?? (await TBA.getEvents(year)).map((event) =>
    normalizeFieldViewEvent(event, {
      tba_event: { status: "available", retrieved_at: retrievedAt },
    }),
  );
  return <EventsBrowser events={events} />;
}
