import type { DurableObjectStateLike, RuntimeEnvironment } from "./cloudflare.ts";

type Role = "controller" | "display";
type Attachment = { role: Role; token: string };
const PROTOCOL = "fieldview.remote.v1";
const isRole = (value: string): value is Role => value === "controller" || value === "display";
const otherRole = (role: Role): Role => role === "controller" ? "display" : "controller";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validPayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "description") {
    return isRecord(value.description) &&
      ["offer", "answer", "pranswer", "rollback"].includes(String(value.description.type)) &&
      (typeof value.description.sdp === "string" || value.description.type === "rollback");
  }
  return value.kind === "candidate" && isRecord(value.candidate) &&
    (typeof value.candidate.candidate === "string" || value.candidate.candidate === null);
}

/**
 * Pair-isolated WebRTC signaling.
 *
 * Presence is represented only by accepted, hibernatable WebSockets. No
 * durable lease, heartbeat, alarm, or periodic storage write is necessary:
 * Cloudflare removes closed sockets from getWebSockets(), including after
 * hibernation, and attachments survive hibernation.
 */
export class RemoteSessionRuntime {
  private readonly state: DurableObjectStateLike;
  private readonly env: RuntimeEnvironment;
  constructor(state: DurableObjectStateLike, env: RuntimeEnvironment) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/connect" || request.method !== "GET") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "WebSocket upgrade required" }, { status: 426 });
    }
    const code = url.searchParams.get("code") ?? "";
    const roleValue = url.searchParams.get("role") ?? "";
    if (!/^\d{6}$/.test(code) || !isRole(roleValue)) {
      return Response.json({ error: "Invalid remote session" }, { status: 400 });
    }
    const role = roleValue;
    const protocols = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
      .split(",").map((item) => item.trim()).filter(Boolean);
    const token = protocols.find((item) => item.startsWith("token."))?.slice(6) ?? "";
    if (!protocols.includes(PROTOCOL) || !protocols.includes("role." + role) ||
        !/^[a-zA-Z0-9_-]{16,128}$/.test(token)) {
      return Response.json({ error: "Invalid remote session credentials" }, { status: 401 });
    }
    if (!this.state.acceptWebSocket || !this.state.getWebSockets) {
      return Response.json({ error: "Hibernatable WebSockets are unavailable" }, { status: 501 });
    }

    // A DO processes these fetch events serially. Checking its accepted socket
    // set is therefore sufficient to enforce one live connection per role.
    if (this.state.getWebSockets().some((socket) => this.attachment(socket)?.role === role)) {
      return Response.json({ error: "This remote role is already connected" }, { status: 409 });
    }

    const pair = this.env.webSocketPairFactory
      ? this.env.webSocketPairFactory()
      : new (globalThis as typeof globalThis & {
          WebSocketPair: new () => { 0: WebSocket; 1: WebSocket };
        }).WebSocketPair();
    const server = pair[1] as WebSocket & { serializeAttachment?: (value: unknown) => void };
    if (!server.serializeAttachment) {
      return Response.json({ error: "WebSocket attachments are unavailable" }, { status: 501 });
    }
    server.serializeAttachment({ role, token } satisfies Attachment);
    this.state.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "connected", role }));

    const other = otherRole(role);
    if (this.hasRole(other)) {
      server.send(JSON.stringify({ type: "peer-ready" }));
      this.sendToRole(other, { type: "peer-ready" });
    }
    return this.env.webSocketResponseFactory
      ? this.env.webSocketResponseFactory(pair[0])
      : new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit & { webSocket: WebSocket });
  }

  private attachment(socket: WebSocket): Attachment | null {
    const value = (socket as WebSocket & { deserializeAttachment?: () => unknown }).deserializeAttachment?.();
    return isRecord(value) && isRole(String(value.role)) && typeof value.token === "string"
      ? { role: value.role as Role, token: value.token } : null;
  }

  private hasRole(role: Role): boolean {
    return (this.state.getWebSockets?.() ?? []).some((socket) => this.attachment(socket)?.role === role);
  }

  private sendToRole(role: Role, message: unknown): void {
    const serialized = JSON.stringify(message);
    for (const socket of this.state.getWebSockets?.() ?? []) {
      if (this.attachment(socket)?.role !== role) continue;
      try { socket.send(serialized); } catch {
        try { socket.close(1011, "Delivery failed"); } catch { /* already closed */ }
      }
    }
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.attachment(socket);
    if (!attachment) {
      try { socket.close(1008, "Invalid session"); } catch { /* closed */ }
      return;
    }
    let body: unknown;
    try {
      const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
      if (raw.length > 96_000) throw new Error("Message too large");
      body = JSON.parse(raw);
    } catch {
      try { socket.close(1009, "Invalid or oversized message"); } catch { /* closed */ }
      return;
    }
    // A hibernated/closed socket may still deliver a queued event in edge
    // cases; confirm it remains an accepted participant before forwarding.
    if (!this.hasRole(attachment.role) ||
        !this.state.getWebSockets?.().some((candidate) =>
          candidate === socket && this.attachment(candidate)?.token === attachment.token)) {
      try { socket.close(1008, "Session is no longer active"); } catch { /* closed */ }
      return;
    }
    if (!isRecord(body) || body.type !== "signal" ||
        body.target !== otherRole(attachment.role) || !validPayload(body.payload)) {
      try { socket.close(1008, "Invalid signaling message"); } catch { /* closed */ }
      return;
    }
    this.sendToRole(otherRole(attachment.role), { type: "signal", payload: body.payload });
  }

  // Hibernation API lifecycle callbacks are intentionally storage-free.
  async webSocketClose(_socket: WebSocket): Promise<void> {}
  async webSocketError(_socket: WebSocket): Promise<void> {}
}
