import { redis } from "@/lib/cache/redis";

export async function GET(
    req: Request,
    { params }: { params: Promise<{ event: string }> }
) {
    const { event } = await params;
    const redisKey = `nexus:event:${event}`;

    const data = await redis.get(redisKey);

    if (!data) {
        console.warn("[Route][Nexus] Nexus data not found in Redis", { event });
        return new Response(null, { status: 204 });
    }

    const payload = JSON.parse(data);
    const etag = `"${payload.dataAsOfTime}"`;

    if (req.headers.get("if-none-match") === etag) {
        console.log("[Route][Nexus] ETag matched, returning 304", {
            event,
            etag,
        });
        return new Response(null, {
            status: 304,
            headers: {
                ETag: etag,
            },
        });
    }
    console.log("[Route][Nexus] ETag did not match, returning payload", {
        event,
        etag,
    });
    return Response.json(payload, {
        headers: {
            ETag: etag,
            "Cache-Control": "no-cache",
        },
    });
}