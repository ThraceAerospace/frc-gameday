import { getEventState, setEventState, computeNextMatch } from "@/lib/eventState";
import { revalidateTag } from "next/cache";

const RELEVANT = new Set([
  "match_score",
  "upcoming_match",
  "schedule_updated",
  "alliance_selection",
  "starting_comp_level",
]);

/* -------------------------- */
/* Helpers                    */
/* -------------------------- */

function safeArray(arr: any) {
  return Array.isArray(arr) ? arr : [];
}

function extractMatch(data: any) {
  return data?.match ?? null;
}

/**
 * Apply webhook delta to matches
 */
function applyDelta(matches: any[], type: string, data: any) {
  matches = safeArray(matches);

  switch (type) {
    case "match_score": {
      const match = extractMatch(data);
      if (!match?.key) return matches;

      return matches.map((m) =>
        m.key === match.key
          ? {
              ...m,
              ...match,
              actual_time:
                match.actual_time ?? match.time ?? m.actual_time,
            }
          : m
      );
    }

    case "schedule_updated": {
      // If TBA includes matches (rare), replace
      if (Array.isArray(data?.matches)) {
        return data.matches;
      }
      return matches;
    }

    case "upcoming_match":
    case "alliance_selection":
    case "starting_comp_level": {
      // no structural change needed
      return matches;
    }

    default:
      return matches;
  }
}

/* -------------------------- */
/* Handler                    */
/* -------------------------- */

export async function POST(req: Request) {
  const payload = await req.json();

  const data = payload?.message_data;
  const type = payload?.message_type;

  const eventKey =
    data?.event_key ||
    data?.eventKey ||
    data?.event?.key;

  if (!eventKey) {
    return new Response("Missing event_key", { status: 400 });
  }

  if (!RELEVANT.has(type)) {
    return new Response("ignored", { status: 200 });
  }

  try {
    /* -------------------------- */
    /* 1. Load state              */
    /* -------------------------- */

    let state = await getEventState(eventKey);

    if (!state) {
      throw new Error("No state exists");
    }

    state.matches = safeArray(state.matches);

    /* -------------------------- */
    /* 2. Apply delta             */
    /* -------------------------- */

    const updatedMatches = applyDelta(state.matches, type, data);

    /* -------------------------- */
    /* 3. Recompute derived       */
    /* -------------------------- */

    const nextMatch = computeNextMatch(updatedMatches);

    const lastMatch =
      [...updatedMatches]
        .reverse()
        .find((m) => m.actual_time !== null) ?? null;

    /* -------------------------- */
    /* 4. Build new state         */
    /* -------------------------- */

    const newState = {
      ...state,
      matches: updatedMatches,
      nextMatch,
      lastMatch,
      version: (state.version ?? 0) + 1,
      updatedAt: Date.now(),
    };

    /* -------------------------- */
    /* 5. Persist                 */
    /* -------------------------- */

    await setEventState(eventKey, newState);

    /* -------------------------- */
    /* 6. Invalidate cache        */
    /* -------------------------- */

    revalidateTag(`event:${eventKey}`, "max");

    return Response.json({ ok: true });
  } catch (err) {
    console.error("[WEBHOOK PATCH FAILED]", err);

    /* -------------------------- */
    /* Fallback: full rebuild     */
    /* -------------------------- */

    const { buildEventState } = await import("@/lib/eventState");

    const rebuilt = await buildEventState(eventKey);

    await setEventState(eventKey, rebuilt);

    revalidateTag(`event:${eventKey}`, "max");

    return Response.json({ ok: true, rebuilt: true });
  }
}