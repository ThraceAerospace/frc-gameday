import SiteShell from "@/components/navigation/SiteShell";
import { getCanonicalEventSnapshot } from "@/lib/events/serverSnapshot";
import EventAnalyticsSurface from "@/components/insights/EventAnalyticsSurface";

export default async function EventAnalyticsPage({ params }: { params: Promise<{ event: string }> }) {
  const { event: eventKey } = await params;
  const canonical = await getCanonicalEventSnapshot(eventKey);
  const event = canonical?.snapshot.event ?? null;
  if (!event) return <SiteShell><div className="mx-auto max-w-6xl p-8"><h1 className="text-2xl font-bold">Event unavailable</h1><p className="mt-2 text-sm text-slate-500">The canonical snapshot does not currently contain {eventKey}.</p></div></SiteShell>;
  return <SiteShell><EventAnalyticsSurface eventKey={event.key} eventName={event.name} /></SiteShell>;
}
