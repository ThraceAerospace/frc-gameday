import { TBA } from "@/lib/tba/service";
import { Statbotics } from "@/lib/statbotics/service";
import type { TBAEventSimple } from "@/lib/tba/types";

async function withConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

export async function GET(request: Request, { params }: { params: Promise<{ team: string }> }) {
  const { team: rawTeam } = await params;
  if (!/^\d{1,6}$/.test(rawTeam)) return Response.json({ error: "Invalid team number" }, { status: 400 });
  const team = Number(rawTeam);
  const year = Number(new URL(request.url).searchParams.get("year") ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 1992 || year > new Date().getFullYear() + 1) {
    return Response.json({ error: "Invalid season year" }, { status: 400 });
  }

  try {
    const [teamInfo, events, season] = await Promise.all([
      TBA.getTeam(`frc${team}`),
      TBA.getTeamEvents(`frc${team}`, year),
      Statbotics.getTeamYear(team, year).catch(() => null),
    ]);
    const officialEvents = [...events]
      .filter((event: TBAEventSimple) => event.event_type !== 99 && event.event_type !== 100)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
    const eventHistory = await withConcurrency(officialEvents, 4, async (event) => {
      try {
        const statbotics = await Statbotics.getTeamEvent(team, event.key);
        return { event, statbotics, status: statbotics ? "ready" as const : "unavailable" as const };
      } catch {
        return { event, statbotics: null, status: "unavailable" as const };
      }
    });
    return Response.json({
      team: teamInfo,
      year,
      season,
      events: eventHistory,
      source: "Statbotics mirror + The Blue Alliance",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[Insights] team history request failed", team, year, error);
    return Response.json({ error: "Team history is temporarily unavailable" }, { status: 502 });
  }
}
