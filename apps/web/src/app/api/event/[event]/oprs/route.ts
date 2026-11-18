import { getCanonicalEventSnapshot } from "@/lib/events/serverSnapshot";

export async function GET(_request: Request, { params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  if (!event) return new Response("Missing event key", { status: 400 });
  const canonical = await getCanonicalEventSnapshot(event);
  if (!canonical) return Response.json({ error: "Event snapshot unavailable" }, { status: 503 });
  if (!canonical.snapshot.sources.event_teams.tba_event_oprs) {
    return Response.json({ error: "Event OPRs have not been acquired" }, { status: 503 });
  }
  if (canonical.snapshot.event_teams === undefined || canonical.snapshot.event_teams === null) {
    return Response.json(canonical.snapshot.event_teams ?? null);
  }
  const oprs: Record<string, number> = {};
  const dprs: Record<string, number> = {};
  const ccwms: Record<string, number> = {};
  for (const team of canonical.snapshot.event_teams) {
    if (team.opr !== undefined) oprs[team.team_key] = team.opr;
    if (team.dpr !== undefined) dprs[team.team_key] = team.dpr;
    if (team.ccwm !== undefined) ccwms[team.team_key] = team.ccwm;
  }
  return Response.json({ oprs, dprs, ccwms });
}
