import { TBA } from "@/lib/tba/service";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ event: string }> },
) {
  const { event } = await params;

  if (!event) {
    return new Response("Missing event key", { status: 400 });
  }

  const data = await TBA.getEventRankings(event);

  return Response.json(data);
}
