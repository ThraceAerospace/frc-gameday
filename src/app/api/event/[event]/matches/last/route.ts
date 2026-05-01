import { TBA } from "@/lib/tbaService";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";
export const revalidate = 2;

function getLastFromList(matches: any[]) {
  let best: any = null;
  let bestTime = -Infinity;

  for (const m of matches) {
    const t = m.actual_time ?? m.post_result_time ?? m.time;
    if (!t) continue;

    const ms = t * 1000;

    if (ms > bestTime && m.actual_time != null) {
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
      last: `${base}:lastMatch`,
      matches: `${base}:matches`,
    };

    /**
     * 1. Load cached last match
     */
    const cachedLast = await redis.get(keys.last);

    if (!cachedLast) {
      return new Response(
        JSON.stringify({ lastMatch: null }),
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=2",
          },
        }
      );
    }

    let lastMatch = JSON.parse(cachedLast);

    /**
     * 2. Refresh that match only
     */
    try {
      const fresh = await TBA.getMatch(lastMatch.key);

      if (fresh) {
        lastMatch = { ...lastMatch, ...fresh };
      }
    } catch (err) {
      console.warn("[LAST MATCH REFRESH FAILED]", err);
    }

    /**
     * 3. Self-heal (rare but useful)
     * If somehow this match is no longer the latest,
     * recompute from cached list
     */
    const cachedMatches = await redis.get(keys.matches);

    if (cachedMatches) {
      const matches = JSON.parse(cachedMatches);

      const correctLast = getLastFromList(matches);

      if (correctLast && correctLast.key !== lastMatch.key) {
        lastMatch = correctLast;
        await redis.set(keys.last, JSON.stringify(correctLast));
      } else {
        // persist refreshed version
        await redis.set(keys.last, JSON.stringify(lastMatch));
      }
    }

    /**
     * 4. Return
     */
    return new Response(
      JSON.stringify({ lastMatch }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=2",
        },
      }
    );
  } catch (err) {
    console.error("[LAST MATCH ROUTE ERROR]", err);

    return new Response(
      JSON.stringify({ error: "Failed to load last match" }),
      { status: 500 }
    );
  }
};