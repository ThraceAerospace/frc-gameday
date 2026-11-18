import { getCanonicalTeamSnapshot } from "@/lib/events/serverSnapshot";

export async function GET(_request: Request, { params }: { params: Promise<{ team: string }> }) {
  const { team: rawTeam } = await params;
  if (!rawTeam) return new Response("Missing team key", { status: 400 });
  const teamKey = /^frc/i.test(rawTeam) ? rawTeam.toLowerCase() : `frc${rawTeam}`;
  const year = new Date().getUTCFullYear();
  const canonical = await getCanonicalTeamSnapshot(teamKey, year);
  if (!canonical) return Response.json({ error: "Team snapshot unavailable" }, { status: 503 });
  if (canonical.snapshot.districts === undefined) return Response.json({ error: "Team districts have not been acquired" }, { status: 503 });
  const current = canonical.snapshot.districts?.find((district) => district.year === year) ?? null;
  return Response.json(current);
}
