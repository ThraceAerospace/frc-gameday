import { redis } from "@/lib/cache/redis";

export async function POST(req: Request) {
    const payload = await req.json();

    console.log("[WEBHOOK][Nexus] Received payload", payload);

    //Accept the message from Nexus if we recieve a new validation token, this means a new webhook has been registered.
    if (payload.token) {
        console.warn("[WEBHOOK][Nexus] Nexus Validation Token Recieved", payload.token);
        return new Response(payload.token, { status: 200 });
    }

    //If we dont have an event key or a dataAsOfTime field then we cant validate it against our cache schema
    if (!payload?.eventKey || !payload?.dataAsOfTime) {
        return new Response("Invalid payload", { status: 400 });
    }

    const redisKey = `nexus:event:${payload.eventKey}`;

    const existingRaw = await redis.get(redisKey);
    const existing = existingRaw ? JSON.parse(existingRaw) : null;

    if (!existing || payload.dataAsOfTime > existing.dataAsOfTime) {
        await redis.set(redisKey, JSON.stringify(payload));
        console.log('[WEBHOOK][Nexus] Updated Redis', {
            eventKey: payload.eventKey,
            dataAsOfTime: payload.dataAsOfTime,
        });
    } else {
        console.warn("[WEBHOOK][Nexus] Ignored stale payload", {
            eventKey: payload.eventKey,
            incoming: payload.dataAsOfTime,
            existing: existing.dataAsOfTime,
        });
    }

    return new Response("ok", { status: 200 });
}