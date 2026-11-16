import { TBA } from "@/lib/tba/service";
import EventsBrowser from "./EventsBrowser";

export default async function EventsPage() {
  const events = await TBA.getEvents(new Date().getFullYear());
  return <EventsBrowser events={events} />;
}
