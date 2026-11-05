import { getEventAnalytics } from "@/lib/insights/service";

export async function GET(request: Request, { params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  if (!event || !/^[a-zA-Z0-9_-]+$/.test(event)) return Response.json({ error: "Invalid event key" }, { status: 400 });
  const url = new URL(request.url);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 20);\n  const liveMatchKey = url.searchParams.get("liveMatchKey");\n  if (liveMatchKey && (!/^[a-zA-Z0-9_]+$/.test(liveMatchKey) || !liveMatchKey.startsWith(`${event}_`))) {\n    return Response.json({ error: "Invalid live match key" }, { status: 400 });\n  }
  if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(limit) || limit < 1 || limit > 40) {
    return Response.json({ error: "Invalid pagination parameters" }, { status: 400 });
  }
  try {
    const result = await getEventAnalytics(event, offset, limit, liveMatchKey);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[Insights] event analytics request failed", event, error);
    return Response.json({ error: "Event analytics are temporarily unavailable" }, { status: 502 });
  }
}
