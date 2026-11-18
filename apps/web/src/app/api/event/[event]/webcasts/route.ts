import { getCanonicalEventSnapshot } from "@/lib/events/serverSnapshot";
import { buildStreams } from "@/lib/tba/buildStreams";

export async function GET(_request: Request, { params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  if (!event) return new Response("Missing event key", { status: 400 });
  const canonical = await getCanonicalEventSnapshot(event);
  if (!canonical) return Response.json({ error: "Event snapshot unavailable" }, { status: 503 });
  if (canonical.snapshot.event === undefined) return Response.json({ error: "Event resource has not been acquired" }, { status: 503 });
  return Response.json(await buildStreams(canonical.snapshot.event?.webcasts ?? []));
}
