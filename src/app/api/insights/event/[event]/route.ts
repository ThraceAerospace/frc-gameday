import { waitUntil } from "@vercel/functions";
import { advanceEventAnalytics, getEventAnalyticsSnapshot } from "@/lib/insights/progressive-service";
import { advanceSeasonCohort, getSeasonCohortSnapshot } from "@/lib/insights/season-cohort";
import { buildSeasonAwareTeamInsights } from "@/lib/insights/calculations";

export const maxDuration = 60;

export async function GET(request: Request, { params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  if (!event || !/^[a-zA-Z0-9_-]+$/.test(event)) {
    return Response.json({ error: "Invalid event key" }, { status: 400 });
  }

  const url = new URL(request.url);
  const liveMatchKey = url.searchParams.get("liveMatchKey");
  if (liveMatchKey && (!/^[a-zA-Z0-9_]+$/.test(liveMatchKey) || !liveMatchKey.startsWith(`${event}_`))) {
    return Response.json({ error: "Invalid live match key" }, { status: 400 });
  }

  try {
    const snapshot = await getEventAnalyticsSnapshot(event);
    const seasonCohort = await getSeasonCohortSnapshot(snapshot.event, snapshot.teams);
    snapshot.seasonCohort = seasonCohort;
    snapshot.teamInsights = buildSeasonAwareTeamInsights(snapshot.matches, snapshot.allianceResults, snapshot.teams, snapshot.rankings ?? null, seasonCohort, snapshot.event.key, snapshot.event.start_date, snapshot.event.playoff_type);
    waitUntil(Promise.all([advanceEventAnalytics(event, liveMatchKey), advanceSeasonCohort(event)]));
    return Response.json(snapshot, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[Insights] event analytics snapshot failed", event, error);
    return Response.json({ error: "Event analytics are temporarily unavailable" }, { status: 502 });
  }
}
