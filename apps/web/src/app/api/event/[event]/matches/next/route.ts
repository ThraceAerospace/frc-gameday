import { TBA } from "@/lib/tba/service";

export async function GET(_req: Request, { params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  if (!event) return new Response("Missing event key", { status: 400 });

  try {
    const nextMatch = await TBA.getNextMatch(event);
    return Response.json(nextMatch);
  } catch (err) {
    console.error("[/next ROUTE ERROR]", err);
    return Response.json({ error: "Failed to compute next match" }, { status: 500 });
  }
}
