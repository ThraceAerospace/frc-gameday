import crypto from "node:crypto";
import { broadcastTBAEvent } from "@/lib/realtime/websocket";

type TBAWebhookData = {
  verification_key?: string;
  event_key?: string;
  event?: { key?: string };
  match?: { event_key?: string };
};

type TBAWebhookPayload = {
  message_type?: string;
  message_data?: TBAWebhookData;
};

type WebhookAuthResult = "missing" | "invalid" | "valid";

function verifyWebhook(
  payload: string,
  signature: string | null,
): WebhookAuthResult {
  if (!signature) return "missing";

  const secret = process.env.TBA_WEBHOOK_TOKEN;

  if (!secret) {
    throw new Error("TBA_WEBHOOK_TOKEN is not configured");
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");
  const signatureBuffer = Buffer.from(signature, "utf8");

  if (expectedBuffer.length !== signatureBuffer.length) {
    return "invalid";
  }

  return crypto.timingSafeEqual(
    expectedBuffer,
    signatureBuffer,
  )
    ? "valid"
    : "invalid";
}

export async function POST(req: Request) {
  const payloadText = await req.text();
  const signature = req.headers.get("X-TBA-HMAC");

  try {
    const auth = verifyWebhook(payloadText, signature);

    if (auth === "missing") {
      return new Response("I'm a teapot", { status: 418 });
    }

    if (auth === "invalid") {
      return new Response("Unauthorized", { status: 401 });
    }
  } catch (error) {
    console.error("[WEBHOOK][TBA] Failed to verify HMAC:", error);
    return new Response("Internal Server Error", { status: 500 });
  }

  let payload: TBAWebhookPayload;

  try {
    payload = JSON.parse(payloadText) as TBAWebhookPayload;
  } catch (error) {
    console.warn("[WEBHOOK][TBA] Invalid JSON payload:", error);
    return new Response("Invalid JSON", { status: 400 });
  }

  const type = payload.message_type;
  const data = payload.message_data;
  const eventKey =
    data?.event_key ??
    data?.event?.key ??
    data?.match?.event_key;

  if (!eventKey || !type) {
    return Response.json({ ok: true });
  }

  try {
    await broadcastTBAEvent(eventKey, type);
  } catch (error) {
    console.error(
      "[WEBHOOK][TBA] Failed to broadcast WebSocket event:",
      error,
    );
    return new Response("Internal Server Error", { status: 500 });
  }

  return Response.json({ ok: true });
}
