import { NextResponse } from "next/server";
import { getEventState, setEventState } from "@/lib/eventState";

export async function POST(req: Request) {
  const body = await req.json();

  const { eventKey, patch } = body;

  if (!eventKey || !patch) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const state = await getEventState(eventKey);

  const newState = {
    ...state,
    ...patch,
    updatedAt: Date.now(),
  };

  await setEventState(eventKey, newState);

  return NextResponse.redirect(
        new URL(`/admin/events?key=${eventKey}`, req.url)
    );
}