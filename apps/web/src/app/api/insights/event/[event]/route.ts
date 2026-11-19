export async function GET(request: Request, { params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  if (!event || !/^[a-zA-Z0-9_-]+$/.test(event)) {
    return Response.json({ error: "Invalid event key" }, { status: 400 });
  }
  const target = new URL(`/api/event/${encodeURIComponent(event)}/analytics`, request.url);
  target.search = new URL(request.url).search;
  return Response.redirect(target, 307);
}
