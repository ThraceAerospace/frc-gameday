import { TBA } from "@/lib/tba/service";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ event: string }> }
) {
  const { event: event } = await params;

  const data = await TBA.getEventWebcasts(event);

  return Response.json(data);
}