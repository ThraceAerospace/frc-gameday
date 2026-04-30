import { getEventData } from "@/lib/tbaEventCache";
import { TBA } from "@/lib/tbaService";

function getNextMatchTime(matches: any[]) {
  const now = Date.now();

  const future = matches
    .map(m => {
      const t = m.actual_time ?? m.predicted_time ?? m.time ?? null;
      return t ? t * 1000 : null; // normalize to ms
    })
    .filter((t): t is number => t !== null && t > now)
    .sort((a, b) => a - b);

  return future[0] ?? null;
}

function getValidUntil(matches: any[]) {
  const now = Date.now();
  const next = getNextMatchTime(matches);

  if (!next) {
    // fallback safety cache
    return now + 30 * 1000;
  }

  // refresh slightly BEFORE next match
  const buffer = 15 * 1000;

  return Math.max(now + 10_000, next - buffer);
}

export const GET = async (
  req: Request,
  { params }: { params: Promise<{ event: string }> }
) => {
  const { event } = await params;

  if (!event) {
    return new Response("Missing event key", { status: 400 });
  }

  const data = await getEventData(
    event,
    "matches",
    30,
    () => TBA.getEventMatches(event)
  );

  const matches = data?.matches ?? data;

  const validUntil = getValidUntil(matches);
  const now = Date.now();

  const maxAge = Math.max(5, Math.floor((validUntil - now) / 1000));

  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",

      // dynamic cache based on match schedule
      "Cache-Control": `public, s-maxage=${maxAge}, stale-while-revalidate=10`
    }
  });
};