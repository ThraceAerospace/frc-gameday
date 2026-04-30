import { getEventState, setEventState, computeNextMatch } from "@/lib/eventState";
import { revalidateTag } from "next/cache";

const RELEVANT = new Set([
  "match_score",
  "upcoming_match",
  "schedule_updated",
  "alliance_selection",
  "starting_comp_level",
]);

export async function POST(req: Request) {
  const payload = await req.json();

  const eventKey = payload?.message_data?.event_key;
  const type = payload?.message_type;

  if (!eventKey) {
    return new Response("Missing event_key", { status: 400 });
  }

  if (!RELEVANT.has(type)) {
    return new Response("ignored", { status: 200 });
  }

  try {
    // 1. load current state
    const state = await getEventState(eventKey);

    if (!state) {
      throw new Error("No state exists");
    }

    // 2. PATCH logic (minimal recompute)
    // NOTE: in practice you'd apply diff from webhook payload here
    const nextMatch = computeNextMatch(state.matches);
    const lastMatch =
      [...state.matches].reverse().find((m) => m.actual_time !== null) ?? null;

    const newState = {
      ...state,
      nextMatch,
      lastMatch,
      version: (state.version ?? 0) + 1,
      updatedAt: Date.now(),
    };

    // 3. persist
    await setEventState(eventKey, newState);

    // 4. invalidate read cache layer (optional but good)
    revalidateTag(`event:${eventKey}`, "max");

    return Response.json({ ok: true });
  } catch (err) {
    console.error("[WEBHOOK PATCH FAILED]", err);

    // fallback: full rebuild
    const { buildEventState } = await import("@/lib/eventState");

    const rebuilt = await buildEventState(eventKey);
    await setEventState(eventKey, rebuilt);

    revalidateTag(`event:${eventKey}`, "max");

    return Response.json({ ok: true, rebuilt: true });
  }
}