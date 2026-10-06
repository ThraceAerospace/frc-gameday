import { experimental_upgradeWebSocket } from "@vercel/functions";
import { registerRemoteWebSocket } from "@/lib/remote/signalingServer";

export const runtime = "nodejs";

export function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const role = url.searchParams.get("role") ?? "";
  const token = url.searchParams.get("token") ?? "";

  if (!/^\d{6}$/.test(code)) return new Response("Invalid pairing code", { status: 400 });
  if (role !== "controller" && role !== "display") return new Response("Invalid remote role", { status: 400 });
  if (!token) return new Response("Missing connection token", { status: 400 });

  return experimental_upgradeWebSocket((socket) => {
    registerRemoteWebSocket(socket, code, role, token);
  });
}
