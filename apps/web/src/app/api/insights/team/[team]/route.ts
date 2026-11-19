import { getCanonicalTeamSnapshot } from "@/lib/events/serverSnapshot";

export const maxDuration = 60;

export async function GET(request: Request, { params }: { params: Promise<{ team: string }> }) {
  const { team: rawTeam } = await params;
  if (!/^\\d{1,6}$/.test(rawTeam)) return Response.json({ error: "Invalid team number" }, { status: 400 });
  const team = Number(rawTeam);
  const year = Number(new URL(request.url).searchParams.get("year") ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 1992 || year > new Date().getFullYear() + 1) {
    return Response.json({ error: "Invalid season year" }, { status: 400 });
  }

  try {
    // TeamRuntime owns both TBA profile acquisition and Statbotics season data.
    // This route is a presentation adapter only; it performs no provider I/O.
    const canonical = await getCanonicalTeamSnapshot(`frc${team}`, year);
    if (!canonical) return Response.json({ error: "Team snapshot unavailable" }, { status: 503 });
    const snapshot = canonical.snapshot;
    if (snapshot.team === undefined || snapshot.events === undefined) {
      return Response.json({ error: "Team profile resources have not been acquired" }, { status: 503 });
    }

    const officialEvents = [...(snapshot.events ?? [])]
      .filter((event) => event.event_type !== 99 && event.event_type !== 100)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
    const statboticsByEvent = new Map((snapshot.statbotics_events ?? []).flatMap((record) =>
      typeof record.event === "string" ? [[record.event, record] as const] : [],
    ));
    const events = officialEvents.map((event) => {
      const statbotics = statboticsByEvent.get(event.key) ?? null;
      return { event, statbotics, status: statbotics ? "ready" as const : "unavailable" as const };
    });

    return Response.json({
      team: snapshot.team,
      year,
      season: snapshot.statbotics ?? null,
      events,
      source: "FieldView canonical team snapshot (The Blue Alliance + Statbotics)",
      updatedAt: Date.now(),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[Insights] canonical team history request failed", team, year, error);
    return Response.json({ error: "Team history is temporarily unavailable" }, { status: 502 });
  }
}
