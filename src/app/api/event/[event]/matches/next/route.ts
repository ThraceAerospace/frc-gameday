import { TBA } from "@/lib/tbaService";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";
export const revalidate = 2;

function getNextFromList(matches: any[], now = Date.now()) {
  let best: any = null;
  let bestTime = Infinity;

  for (const m of matches) {
    const t = m.predicted_time ?? m.time;
    if (!t || m.actual_time != null) continue;

    const ms = t * 1000;

    if (ms > now && ms < bestTime) {
      bestTime = ms;
      best = m;
    }
  }

  return best;
}

export const GET = async (
  req: Request,
  { params }: { params: Promise<{ event: string }> }
) => {
  const { event: eventKey } = await params;

  if (!eventKey) {
    return new Response("Missing event key", { status: 400 });
  }

  try {
    const base = `cache:event:${eventKey}`;

    const keys = {
      next: `${base}:nextMatch`,
      matches: `${base}:matches`,
    };

    /**
     * 1. Load cached next match
     */
    const cachedNext = await redis.get(keys.next);

    if (!cachedNext) {
      return new Response(
        JSON.stringify({ nextMatch: null }),
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=2",
          },
        }
      );
    }

    let nextMatch = JSON.parse(cachedNext);

    /**
     * 2. Refresh that match only
     */
    try {
      const fresh = await TBA.getMatch(nextMatch.key);

      if (fresh) {
        nextMatch = { ...nextMatch, ...fresh };
      }
    } catch (err) {
      console.warn("[NEXT MATCH REFRESH FAILED]", err);
    }

    /**
     * 3. If match is now played → advance locally
     */
    if (nextMatch.actual_time != null) {
      const cachedMatches = await redis.get(keys.matches);

      if (cachedMatches) {
        const matches = JSON.parse(cachedMatches);

        const newNext = getNextFromList(matches);

        if (newNext) {
          nextMatch = newNext;

          await redis.set(keys.next, JSON.stringify(newNext));
        } else {
          await redis.del(keys.next);
          nextMatch = null;
        }
      }
    } else {
      // persist refreshed version
      await redis.set(keys.next, JSON.stringify(nextMatch));
    }

    /**
     * 4. Return
     */
    return new Response(
      JSON.stringify({ nextMatch }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=2",
        },
      }
    );
  } catch (err) {
    console.error("[NEXT MATCH ROUTE ERROR]", err);

    return new Response(
      JSON.stringify({ error: "Failed to load next match" }),
      { status: 500 }
    );
  }
};