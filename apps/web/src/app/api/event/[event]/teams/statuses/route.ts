import { getCanonicalEventSnapshot } from "@/lib/events/serverSnapshot";

export async function GET(_request: Request, { params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  if (!event) return new Response("Missing event key", { status: 400 });
  const canonical = await getCanonicalEventSnapshot(event);
  if (!canonical) return Response.json({ error: "Event snapshot unavailable" }, { status: 503 });
  if (!canonical.snapshot.sources.event_teams.tba_team_event_status) {
    return Response.json({ error: "Team event statuses have not been acquired" }, { status: 503 });
  }
  if (canonical.snapshot.event_teams === undefined || canonical.snapshot.event_teams === null) {
    return Response.json(canonical.snapshot.event_teams ?? null);
  }
  const statuses = Object.fromEntries(canonical.snapshot.event_teams.flatMap((team) =>
    team.tba_status === undefined ? [] : [[team.team_key, team.tba_status]],
  ));
  return Response.json(statuses);
}
