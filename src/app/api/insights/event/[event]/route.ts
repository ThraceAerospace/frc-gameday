import { advanceEventAnalytics, getEventAnalyticsSnapshot } from "@/lib/insights/progressive-service";
import { advanceSeasonCohort, getSeasonCohortSnapshot } from "@/lib/insights/season-cohort";
import { buildSeasonAwareTeamInsights } from "@/lib/insights/calculations";

export const maxDuration = 60;

export async function GET(request: Request, { params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  if (!event || !/^[a-zA-Z0-9_-]+$/.test(event)) {
    return Response.json({ error: "Invalid event key" }, { status: 400 });
  }

  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";

  try {
    // Complete the initial acquisition before returning. Subsequent dashboard
    // opens read the persisted snapshot and make no Statbotics requests.
    await getEventAnalyticsSnapshot(event);
    await Promise.all([
      advanceEventAnalytics(event, forceRefresh),
      advanceSeasonCohort(event, forceRefresh),
    ]);

    const snapshot = await getEventAnalyticsSnapshot(event);
    const seasonCohort = await getSeasonCohortSnapshot(snapshot.event, snapshot.teams);
    snapshot.seasonCohort = seasonCohort;
    snapshot.teamInsights = buildSeasonAwareTeamInsights(
      snapshot.matches,
      snapshot.allianceResults,
      snapshot.teams,
      snapshot.rankings ?? null,
      seasonCohort,
      snapshot.event.key,
      snapshot.event.start_date,
      snapshot.event.playoff_type,
    );
    return Response.json(snapshot, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[Insights] event analytics snapshot failed", event, error);
    return Response.json({ error: "Event analytics are temporarily unavailable" }, { status: 502 });
  }
}
