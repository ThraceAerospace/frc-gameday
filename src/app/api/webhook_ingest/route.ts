import {
  getEventState,
  setEventState,
  computeNextMatch,
  buildEventState,
} from "@/lib/eventState";

import { revalidateTag } from "next/cache";

/* -------------------------- */
/* Config                    */
/* -------------------------- */

const RELEVANT = new Set([
  "match_score",
  "upcoming_match",
  "schedule_updated",
  "alliance_selection",
  "starting_comp_level",
]);

const FORCE_REBUILD = new Set([
  "schedule_updated",
  "alliance_selection",
  "starting_comp_level",
]);

/* -------------------------- */
/* Helpers                   */
/* -------------------------- */

function safeArray(arr: any) {
  return Array.isArray(arr) ? arr : [];
}

function extractMatch(data: any) {
  return data?.match ?? null;
}

/**
 * Validate state integrity
 */
function isValidState(state: any) {
  if (!state?.matches) return false;
  if (!Array.isArray(state.matches)) return false;
  if (state.matches.length === 0) return false;

  return true;
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
        m.key === match.key ? { ...m, ...match } : m
      );
    }

    case "upcoming_match": {
      const match = extractMatch(data);
      if (!match?.key) return matches;

      return matches.map((m) =>
        m.key === match.key
          ? {
              ...m,
              predicted_time: match.predicted_time ?? m.predicted_time,
            }
          : m
      );
    }

    default:
      return matches;
  }
}

/* -------------------------- */
/* Handler                   */
/* -------------------------- */

export async function POST(req: Request) {
  const payload = await req.json();

  const data = payload?.message_data;
  const type = payload?.message_type;

  const eventKey =
    data?.event_key || data?.eventKey || data?.event?.key;

    console.log(`[WEBHOOK] Received ${type} for ${eventKey}`, { data });

  if (!eventKey) {
    return new Response("Missing event_key", { status: 400 });
  }

  if (!RELEVANT.has(type)) {
    return new Response("ignored", { status: 200 });
  }

  try {
    /* -------------------------- */
    /* 1. Load state             */
    /* -------------------------- */

    let state = await getEventState(eventKey);

    if (!state) {
      state = await buildEventState(eventKey);
    }

    state.matches = safeArray(state.matches);

    /* 🚨 Force rebuild triggers */
    if (FORCE_REBUILD.has(type)) {
      const rebuilt = await buildEventState(eventKey);

      await setEventState(eventKey, rebuilt);
      revalidateTag(`event:${eventKey}`, "max");

      return Response.json({ ok: true, rebuilt: true });
    }

    /* -------------------------- */
    /* 2. Apply delta            */
    /* -------------------------- */

    const updatedMatches = applyDelta(state.matches, type, data);

    /* -------------------------- */
    /* 3. Validate result        */
    /* -------------------------- */

    const nextMatch = computeNextMatch(updatedMatches);

    const lastMatch =
      [...updatedMatches]
        .reverse()
        .find((m) => m.actual_time !== null) ?? null;

    const newState = {
      ...state,
      matches: updatedMatches,
      nextMatch,
      lastMatch,
      version: (state.version ?? 0) + 1,
      updatedAt: Date.now(),
    };

    /* 🧪 Safety check */
    if (!isValidState(newState)) {
      console.warn("[WEBHOOK] Invalid state detected → rebuilding");

      const rebuilt = await buildEventState(eventKey);

      await setEventState(eventKey, rebuilt);
      revalidateTag(`event:${eventKey}`, "max");

      return Response.json({ ok: true, rebuilt: true, reason: "invalid" });
    }

    /* -------------------------- */
    /* 4. Persist                */
    /* -------------------------- */

    await setEventState(eventKey, newState);

    /* -------------------------- */
    /* 5. Invalidate cache       */
    /* -------------------------- */

    revalidateTag(`event:${eventKey}`, "max");

    return Response.json({ ok: true });
  } catch (err) {
    console.error("[WEBHOOK PATCH FAILED]", err);

    /* -------------------------- */
    /* Full fallback rebuild     */
    /* -------------------------- */

    const rebuilt = await buildEventState(eventKey);

    await setEventState(eventKey, rebuilt);

    revalidateTag(`event:${eventKey}`, "max");

    return Response.json({ ok: true, rebuilt: true });
  }
}