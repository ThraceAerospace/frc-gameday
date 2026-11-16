import SiteShell from "@/components/navigation/SiteShell";
import { TBA } from "@/lib/tba/service";
import EventAnalyticsSurface from "@/components/insights/EventAnalyticsSurface";

export default async function EventAnalyticsPage({ params }: { params: Promise<{ event: string }> }) {
  const { event: eventKey } = await params;
  const event = await TBA.getEvent(eventKey).catch(() => null);
  if (!event) return <SiteShell><div className="mx-auto max-w-6xl p-8"><h1 className="text-2xl font-bold">Event unavailable</h1><p className="mt-2 text-sm text-slate-500">Could not load {eventKey}.</p></div></SiteShell>;
  return <SiteShell><EventAnalyticsSurface eventKey={event.key} eventName={event.name} /></SiteShell>;
}
