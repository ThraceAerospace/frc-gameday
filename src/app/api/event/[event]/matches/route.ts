// /api/event/[event]/matches/route.ts

import { TBA } from "@/lib/tba/service";

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ event: string }> }
) {
    const { event } = await params;

    const matches = await TBA.getEventMatches(event);

    return Response.json(matches);
}