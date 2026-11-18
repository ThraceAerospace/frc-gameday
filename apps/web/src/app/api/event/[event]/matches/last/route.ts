import { getCanonicalEventSnapshot } from "@/lib/events/serverSnapshot";
import { getLastMatch } from "@/lib/tba/matchUtils";

export async function GET(_request: Request, { params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  if (!event) return new Response("Missing event key", { status: 400 });
  const canonical = await getCanonicalEventSnapshot(event);
  if (!canonical) return Response.json({ error: "Event snapshot unavailable" }, { status: 503 });
  if (canonical.snapshot.matches === undefined) return Response.json({ error: "Event matches have not been acquired" }, { status: 503 });
  if (canonical.snapshot.matches === null) return Response.json(null);
  return Response.json(getLastMatch(canonical.snapshot.matches));
}
