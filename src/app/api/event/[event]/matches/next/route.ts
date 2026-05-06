import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function sortMatches(matches: any[]) {
  return [...(matches ?? [])].sort((a, b) => {
    const ta = a?.predicted_time ?? Infinity;
    const tb = b?.predicted_time ?? Infinity;
    return ta - tb;
  });
}

/**
 * PURE STATE RULE:
 * next match = first unplayed match in deterministic order
 */
function getNextMatch(matches: any[]) {
  for (const m of matches) {
    if (m?.actual_time == null) return m;
  }
  return null;
}

/**
 * last match = last played match in deterministic order
 */
function getLastMatch(matches: any[]) {
  let last = null;

  for (const m of matches) {
    if (m?.actual_time != null) {
      last = m;
    }
  }

  return last;
}

function isSameMatch(a: any, b: any) {
  if (!a || !b) return false;

  return a.match_key === b.match_key;
}

export const GET = async (
  req: Request,
  { params }: { params: Promise<{ event: string }> }
) => {
  const { event: eventKey } = await params;

  if (!eventKey) {
    return new Response("Missing event key", { status: 400 });
  }

  const base = `cache:event:${eventKey}`;

  const keys = {
    matches: `${base}:matches`,
    next: `${base}:nextMatch`,
  };

  try {
    /**
     * STEP 1 — load canonical match list
     */
    const raw = await redis.get(keys.matches);

    if (!raw) {
      return Response.json(
        { nextMatch: null },
        { headers: { "Cache-Control": "public, max-age=2" } }
      );
    }

    const matches = sortMatches(JSON.parse(raw));

    /**
     * STEP 2 — derive state
     */
    const nextMatch = getNextMatch(matches);
    //const lastMatch = getLastMatch(matches);

    /**
     * STEP 3 — compare cached pointer (optional optimization)
     */
    const cachedRaw = await redis.get(keys.next);
    let cachedNext = null;

    if (cachedRaw) {
      cachedNext = JSON.parse(cachedRaw);
    }

    const changed = !isSameMatch(cachedNext, nextMatch);

    /**
     * STEP 4 — update cache ONLY if needed
     */
    if (changed) {
      if (nextMatch) {
        await redis.set(keys.next, JSON.stringify(nextMatch));
      } else {
        await redis.del(keys.next);
      }
    }

    /**
     * STEP 5 — return deterministic result
     */
    return Response.json(
      {
        nextMatch
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=2",
        },
      }
    );
  } catch (err) {
    console.error("[/next ROUTE ERROR]", err);

    return Response.json(
      { error: "Failed to compute next match" },
      { status: 500 }
    );
  }
};