import { TBA } from "@/lib/tba/service";

export async function GET(_req: Request, { params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  if (!event) return new Response("Missing event key", { status: 400 });

  try {
    const lastMatch = await TBA.getLastMatch(event);
    return Response.json(lastMatch);
  } catch (err) {
    console.error("[/last ROUTE ERROR]", err);
    return Response.json({ error: "Failed to load last match" }, { status: 500 });
  }
}
