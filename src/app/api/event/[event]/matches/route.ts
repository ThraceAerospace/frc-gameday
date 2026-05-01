import { TBA } from "@/lib/tbaService";
import { redis } from "@/lib/redis";

function getNextMatch(matches: any[], now = Date.now()) {
  let best: any = null;
  let bestTime = Infinity;

  for (const m of matches) {
    const t = m.predicted_time ?? m.time;
    if (!t) continue;

    const ms = t * 1000;

    if (ms > now && ms < bestTime) {
      bestTime = ms;
      best = m;
    }
  }

  return best;
}

function getLastMatch(matches: any[], now = Date.now()) {
  let best: any = null;
  let bestTime = -Infinity;

  for (const m of matches) {
    const t = m.actual_time ?? m.time;
    if (!t) continue;

    const ms = t * 1000;

    if (ms <= now && ms > bestTime) {
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
    /**
     * 1. Source of truth (ETag + Redis handled inside TBA client)
     */
    const data = await TBA.getEventMatches(eventKey);

    const matchList = Array.isArray(data)
      ? data
      : data?.matches ?? [];

    const now = Date.now();

    /**
     * 2. Derive state (FULL OBJECTS ONLY)
     */
    const nextMatch = getNextMatch(matchList, now);
    const lastMatch = getLastMatch(matchList, now);

    /**
     * 3. Redis keys (strict subresource separation)
     */
    const base = `cache:event:${eventKey}`;

    const keys = {
      matches: `${base}:matches`,
      next: `${base}:nextMatch`,
      last: `${base}:lastMatch`,
    };

    /**
     * 4. Persist full canonical state
     */
    await redis.set(keys.matches, JSON.stringify(matchList));

    if (nextMatch) {
      await redis.set(keys.next, JSON.stringify(nextMatch));
    } else {
      await redis.del(keys.next);
    }

    if (lastMatch) {
      await redis.set(keys.last, JSON.stringify(lastMatch));
    } else {
      await redis.del(keys.last);
    }

    /**
     * 5. Response
     */
    return new Response(
      JSON.stringify({
        matches: matchList,
        nextMatch,
        lastMatch,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=5",
        },
      }
    );
  } catch (err) {
    console.error("[MATCH ROUTE ERROR]", err);

    return new Response(
      JSON.stringify({ error: "Failed to load matches" }),
      { status: 500 }
    );
  }
};