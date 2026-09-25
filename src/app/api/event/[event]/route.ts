import { TBA } from "@/lib/tba/service";

export const GET = async (  req: Request,
  { params }: { params: Promise<{ event: string }> }) => {
  const { event: event } = await params;

  if (!event) {
    return new Response("Missing event key", { status: 400 });
  }

  const data = await TBA.getEvent(event);

  return Response.json(data);
};