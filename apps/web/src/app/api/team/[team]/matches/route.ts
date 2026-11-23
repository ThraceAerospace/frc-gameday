import { getCanonicalCurrentSeason, getCanonicalTeamAnalytics } from "@/lib/events/serverSnapshot";

export async function GET(request: Request, { params }: { params: Promise<{ team: string }> }) {
  const { team: rawTeam } = await params;
  if (!/^\d{1,6}$/.test(rawTeam)) return Response.json({ error: "Invalid team number" }, { status: 400 });

  const teamNumber = Number(rawTeam);
  const requestedYear = new URL(request.url).searchParams.get("year");
  const currentSeason = requestedYear === null ? await getCanonicalCurrentSeason() : null;
  if (requestedYear === null && !currentSeason) return Response.json({ error: "TBA current season is unavailable" }, { status: 503 });
  const year = requestedYear === null ? currentSeason!.year : Number(requestedYear);
  if (!Number.isInteger(year) || year < 1992 || year > 2200) {
    return Response.json({ error: "Invalid season year" }, { status: 400 });
  }

  const canonical = await getCanonicalTeamAnalytics("frc" + teamNumber, year);
  if (!canonical) return Response.json({ error: "Canonical team analytics unavailable" }, { status: 503 });
  return Response.json(canonical, { headers: { "Cache-Control": "private, no-store" } });
}
