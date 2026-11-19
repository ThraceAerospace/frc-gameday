import { getCanonicalEventAnalytics } from "@/lib/events/serverSnapshot";

export async function GET(_request: Request, { params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  if (!event || !/^[a-zA-Z0-9_-]+$/.test(event)) {
    return Response.json({ error: "Invalid event key" }, { status: 400 });
  }
  const canonical = await getCanonicalEventAnalytics(event);
  if (!canonical) return Response.json({ error: "Canonical event analytics unavailable" }, { status: 503 });
  return Response.json(canonical, { headers: { "Cache-Control": "private, no-store" } });
}
