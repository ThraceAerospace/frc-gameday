import { TBA } from "@/lib/tba/service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ event: string }> },
) {
  const { event } = await params;

  if (!event) {
    return new Response("Missing event key", { status: 400 });
  }

  return Response.json(await TBA.getEventOPRs(event));
}
