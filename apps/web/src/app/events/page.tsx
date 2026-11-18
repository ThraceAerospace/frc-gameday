import { getCanonicalEventDiscovery } from "@/lib/events/serverSnapshot";
import EventsBrowser from "./EventsBrowser";

export default async function EventsPage() {
  const year = new Date().getUTCFullYear();
  const canonicalEvents = await getCanonicalEventDiscovery(year);
  return <EventsBrowser events={canonicalEvents ?? []} unavailable={canonicalEvents === null} />;
}
