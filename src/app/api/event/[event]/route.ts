import { TBA } from "@/lib/tbaService";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ event: string }> }
) {
  const { event: event } = await params;

  const data = await TBA.getEvent(event);

  return Response.json(data, {
    headers:{
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=500"
    }
  });
}