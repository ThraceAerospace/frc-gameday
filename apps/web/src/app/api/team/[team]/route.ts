import { getCanonicalTeamSnapshot } from "@/lib/events/serverSnapshot";

export async function GET(_request: Request, { params }: { params: Promise<{ team: string }> }) {
  const { team: rawTeam } = await params;
  if (!rawTeam) return new Response("Missing team key", { status: 400 });
  const teamKey = /^frc/i.test(rawTeam) ? rawTeam.toLowerCase() : `frc${rawTeam}`;
  const canonical = await getCanonicalTeamSnapshot(teamKey, new Date().getUTCFullYear());
  if (!canonical) return Response.json({ error: "Team snapshot unavailable" }, { status: 503 });
  if (canonical.snapshot.team === undefined) return Response.json({ error: "Team resource has not been acquired" }, { status: 503 });
  return Response.json(canonical.snapshot.team);
}
