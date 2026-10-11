import { TBA } from "@/lib/tba/service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ event: string }> },
) {
  const { event } = await params;

  if (!event) {
    return new Response("Missing event key", { status: 400 });
  }

  const data = await TBA.getEventOPRs(event);

  return Response.json(data);
}
