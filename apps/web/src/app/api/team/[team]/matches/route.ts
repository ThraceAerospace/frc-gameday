import type { FieldViewTeamAnalytics } from "@fieldview/domain";
import { buildSeasonDiagnostics } from "@fieldview/analytics/season-diagnostics";
import type { SeasonMatchEvidence } from "@fieldview/analytics/season-diagnostics";
import { getCanonicalEventSnapshot, getCanonicalTeamSnapshot } from "@/lib/events/serverSnapshot";

type TeamEventReference = {
  key: string;
  name: string;
  event_code?: string | null;
  start_date: string;
  event_type?: number;
};


export async function GET(request: Request, { params }: { params: Promise<{ team: string }> }) {
  const { team: rawTeam } = await params;
  if (!/^\d{1,6}$/.test(rawTeam)) return Response.json({ error: "Invalid team number" }, { status: 400 });

  const teamNumber = Number(rawTeam);
  const year = Number(new URL(request.url).searchParams.get("year") ?? new Date().getUTCFullYear());
  if (!Number.isInteger(year) || year < 1992 || year > new Date().getUTCFullYear() + 1) {
    return Response.json({ error: "Invalid season year" }, { status: 400 });
  }

  const canonical = await getCanonicalTeamSnapshot(`frc${teamNumber}`, year);
  if (!canonical) return Response.json({ error: "Canonical team snapshot unavailable" }, { status: 503 });

  if (canonical.snapshot.events === undefined || canonical.snapshot.events === null) {
    return Response.json({ error: "Team season event list is still being acquired" }, { status: 503 });
  }

  const events = canonical.snapshot.events
    .filter((event) => event.event_type !== 99 && event.event_type !== 100)
    .sort((a, b) => a.start_date.localeCompare(b.start_date)) as TeamEventReference[];

  const eventResults = await Promise.all(events.map(async (event) => {
    const response = await getCanonicalEventSnapshot(event.key);
    const snapshot = response?.snapshot;
    const teamState = snapshot?.team_states?.find((entry) => entry.team_key === `frc${teamNumber}`);
    const analytics = (teamState?.analytics ?? null) as FieldViewTeamAnalytics | null;
    return {
      event: {
        key: event.key,
        name: snapshot?.event?.name ?? event.name,
        shortName: snapshot?.event?.short_name ?? event.event_code ?? null,
        startDate: snapshot?.event?.start_date ?? event.start_date,
      },
      status: !snapshot ? "unavailable" as const
        : analytics ? "ready" as const : "pending" as const,
      analytics,
    };
  }));

  const seasonEvidence: SeasonMatchEvidence[] = eventResults.flatMap((entry) =>
    (entry.analytics?.match_evidence ?? []).map((match) => ({ ...match, event: entry.event })),
  );
  const diagnostics = buildSeasonDiagnostics(seasonEvidence);
  const ready = eventResults.filter((entry) => entry.analytics !== null);
  const completedMatches = ready.reduce((sum, entry) =>
    sum + (entry.analytics?.performance?.completed_matches ?? 0), 0);
  const matchesSeen = ready.reduce((sum, entry) =>
    sum + (entry.analytics?.performance?.matches_seen ?? 0), 0);

  return Response.json({
    team: teamNumber,
    year,
    eventCount: events.length,
    analyzedEventCount: ready.length,
    matchCount: completedMatches,
    matchesSeen,
    events: eventResults,
    summary: diagnostics.overall,
    phaseSummaries: diagnostics.phaseSummaries,
    eliminationShift: diagnostics.eliminationShift,
    residualPattern: diagnostics.residualPattern,
    anomalySummary: diagnostics.anomalySummary,
    anomalies: diagnostics.anomalies,
    collection: {
      state: ready.length === events.length ? "complete" : ready.length > 0 ? "partial" : "pending",
      analyzedEvents: ready.length,
      totalEvents: events.length,
      updatedAt: Date.now(),
    },
  }, { headers: { "Cache-Control": "private, no-store" } });
}
