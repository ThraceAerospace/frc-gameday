import {
  experimental_upgradeWebSocket,
} from "@vercel/functions";
import {
  registerWebSocket,
} from "@/lib/realtime/websocket";

export const runtime = "nodejs";

export function GET() {
  return experimental_upgradeWebSocket(
    (socket) => {
      registerWebSocket(socket);
    },
  );
}
