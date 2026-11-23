import { getCanonicalCurrentSeason, getCanonicalEventDiscovery } from "@/lib/events/serverSnapshot";
import EventsBrowser from "./EventsBrowser";

export default async function EventsPage() {
  const currentSeason = await getCanonicalCurrentSeason();
  const canonicalEvents = currentSeason ? await getCanonicalEventDiscovery(currentSeason.year) : null;
  return <EventsBrowser events={canonicalEvents ?? []} unavailable={canonicalEvents === null} />;
}
