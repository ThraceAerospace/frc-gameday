import {
  experimental_upgradeWebSocket,
} from "@vercel/functions";
import {
  registerWebSocket,
} from "@/lib/realtime/websocket";

export const runtime = "nodejs";

export function GET(request: Request) {
  const url = new URL(request.url);
  const eventKey =
    url.searchParams.get("event");

  if (!eventKey) {
    return new Response(
      "Missing event parameter",
      { status: 400 },
    );
  }

  return experimental_upgradeWebSocket(
    (socket) => {
      registerWebSocket(
        socket,
        eventKey,
      );
    },
  );
}