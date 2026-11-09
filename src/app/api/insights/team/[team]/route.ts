import { redis } from "@/lib/cache/redis";
import { TBA } from "@/lib/tba/service";
import { Statbotics } from "@/lib/statbotics/service";
import type { TBAEventSimple } from "@/lib/tba/types";

const TEAM_HISTORY_TTL_SECONDS = 30 * 24 * 60 * 60;


export const maxDuration = 60;

export async function GET(request: Request, { params }: { params: Promise<{ team: string }> }) {
  const { team: rawTeam } = await params;
  if (!/^\d{1,6}$/.test(rawTeam)) return Response.json({ error: "Invalid team number" }, { status: 400 });
  const team = Number(rawTeam);
  const year = Number(new URL(request.url).searchParams.get("year") ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 1992 || year > new Date().getFullYear() + 1) {
    return Response.json({ error: "Invalid season year" }, { status: 400 });
  }

  const cacheKey = `cache:insights:team-history:${team}:${year}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    try { return Response.json(JSON.parse(cached), { headers: { "Cache-Control": "private, no-store" } }); }
    catch { await redis.del(cacheKey); }
  }

  try {
    const [teamInfo, events, season, statboticsEvents] = await Promise.all([
      TBA.getTeam(`frc${team}`),
      TBA.getTeamEvents(`frc${team}`, year),
      Statbotics.getTeamYear(team, year).catch(() => null),
      Statbotics.getTeamEvents({ team, year }).catch(() => []),
    ]);
    const officialEvents = [...events]
      .filter((event: TBAEventSimple) => event.event_type !== 99 && event.event_type !== 100)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
    const statboticsByEvent = new Map(statboticsEvents.flatMap((record) =>
      typeof record.event === "string" ? [[record.event, record] as const] : [],
    ));
    const eventHistory = officialEvents.map((event) => {
      const statbotics = statboticsByEvent.get(event.key) ?? null;
      return { event, statbotics, status: statbotics ? "ready" as const : "unavailable" as const };
    });
    const payload = {
      team: teamInfo,
      year,
      season,
      events: eventHistory,
      source: "Statbotics mirror + The Blue Alliance",
      updatedAt: Date.now(),
    };
    await redis.set(cacheKey, JSON.stringify(payload), "EX", TEAM_HISTORY_TTL_SECONDS);
    return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[Insights] team history request failed", team, year, error);
    return Response.json({ error: "Team history is temporarily unavailable" }, { status: 502 });
  }
}
