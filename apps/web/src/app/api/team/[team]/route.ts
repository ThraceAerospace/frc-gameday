import { getCanonicalTeamSnapshot } from "@/lib/events/serverSnapshot";

export async function GET(_request: Request, { params }: { params: Promise<{ team: string }> }) {
  const { team: rawTeam } = await params;
  if (!/^(?:frc)?\\d{1,6}$/i.test(rawTeam)) return Response.json({ error: "Invalid team number" }, { status: 400 });
  const teamKey = `frc${rawTeam.replace(/^frc/i, "")}`.toLowerCase();
  const canonical = await getCanonicalTeamSnapshot(teamKey, new Date().getUTCFullYear());
  if (!canonical) return Response.json({ error: "Team snapshot unavailable" }, { status: 503 });
  if (canonical.snapshot.team === undefined) return Response.json({ error: "Team resource has not been acquired" }, { status: 503 });
  return Response.json(canonical.snapshot.team);
}
