import { getEventState, setEventState } from "@/lib/eventState";
import { buildEventState } from "@/lib/eventState";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ event: string }> }
) {
  const { event } = await params;

  let state = await getEventState(event);

  if (!state) {
    console.log("[STATE MISS] rebuilding:", event);

    state = await buildEventState(event);
    await setEventState(event, state);
  }

  return Response.json(state, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}