import { broadcastTBAEvent } from "@/lib/realtime/websocket";

type TBAWebhookData = {
  event_key?: string;
  event?: { key?: string };
  match?: { event_key?: string };
};

type TBAWebhookPayload = {
  message_type?: string;
  message_data?: TBAWebhookData;
};

function eventKeyFrom(payload: TBAWebhookPayload): string | null {
  const key = payload.message_data?.event_key ??
    payload.message_data?.event?.key ??
    payload.message_data?.match?.event_key;
  return typeof key === "string" && /^[a-zA-Z0-9_-]+$/.test(key) ? key : null;
}

/**
 * Compatibility ingress while TBA's webhook configuration is moved to the
 * Cloudflare Worker. Provider reconciliation happens in EventRuntime; this
 * Vercel route only relays the signed request and keeps the legacy WSS bridge
 * informed until every WSS consumer has migrated.
 */
export async function POST(request: Request) {
  const runtimeOrigin = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  if (!runtimeOrigin) {
    return Response.json({ error: "FieldView runtime is not configured" }, { status: 503 });
  }

  try {
    const payloadText = await request.text();
    const headers = new Headers({ "Content-Type": "application/json" });
    const signature = request.headers.get("X-TBA-HMAC");
    if (signature) headers.set("X-TBA-HMAC", signature);

    const workerUrl = new URL("/webhooks/tba", runtimeOrigin);
    const workerResponse = await fetch(workerUrl, {
      method: "POST",
      headers,
      body: payloadText,
      cache: "no-store",
    });
    const responseBody = await workerResponse.arrayBuffer();

    if (workerResponse.ok) {
      try {
        const payload = JSON.parse(payloadText) as TBAWebhookPayload;
        const eventKey = eventKeyFrom(payload);
        if (eventKey) {
          try {
            await broadcastTBAEvent(
              eventKey,
              payload.message_type,
              payload.message_data as Record<string, unknown>,
            );
          } catch (error) {
            // Worker reconciliation has already succeeded. Legacy WSS delivery
            // is best-effort and remains backed by the existing bridge for now.
            console.error("[WEBHOOK][TBA] Legacy WSS broadcast failed:", error);
          }
        }
      } catch {
        // The Worker is authoritative for payload validation and its response
        // is relayed unchanged. Do not mask that response with a second parse.
      }
    }

    return new Response(responseBody, {
      status: workerResponse.status,
      statusText: workerResponse.statusText,
      headers: {
        "Content-Type": workerResponse.headers.get("Content-Type") ?? "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[WEBHOOK][TBA] Cloudflare runtime relay failed:", error);
    return Response.json({ error: "FieldView runtime is temporarily unavailable" }, { status: 502 });
  }
}
