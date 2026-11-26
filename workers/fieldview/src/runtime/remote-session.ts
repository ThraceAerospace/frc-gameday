import type { DurableObjectStateLike, RuntimeEnvironment } from "./cloudflare.ts";

type Role = "controller" | "display";
type Lease = { token: string; expiresAt: number };
type Attachment = { role: Role; token: string };
const LEASE_MS = 120_000;
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

/** Pair-isolated WebRTC signaling with expiring controller/display role leases. */
export class RemoteSessionRuntime {
  constructor(private readonly state: DurableObjectStateLike, private readonly env: RuntimeEnvironment) {}

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

    const key = "role:" + role;
    const existing = await this.state.storage.get<Lease>(key);
    if (existing && existing.expiresAt > Date.now()) {
      return Response.json({ error: "This remote role is already connected" }, { status: 409 });
    }
    if (existing) await this.state.storage.delete(key);
    if (!this.state.acceptWebSocket) {
      return Response.json({ error: "WebSocket sessions are unavailable" }, { status: 501 });
    }
    const pair = this.env.webSocketPairFactory
      ? this.env.webSocketPairFactory()
      : new (globalThis as typeof globalThis & {
          WebSocketPair: new () => { 0: WebSocket; 1: WebSocket };
        }).WebSocketPair();
    const server = pair[1] as WebSocket & { serializeAttachment?: (value: unknown) => void };
    server.serializeAttachment?.({ role, token } satisfies Attachment);
    await this.state.storage.put<Lease>(key, { token, expiresAt: Date.now() + LEASE_MS });
    this.state.acceptWebSocket(server);
    await this.scheduleExpiry();
    server.send(JSON.stringify({ type: "connected", role }));
    const other = otherRole(role);
    const otherLease = await this.state.storage.get<Lease>("role:" + other);
    if (otherLease && otherLease.expiresAt > Date.now()) {
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
    const key = "role:" + attachment.role;
    const lease = await this.state.storage.get<Lease>(key);
    if (!lease || lease.token !== attachment.token || lease.expiresAt <= Date.now()) {
      try { socket.close(1008, "Session lease expired"); } catch { /* closed */ }
      return;
    }
    if (isRecord(body) && body.type === "heartbeat") {
      await this.state.storage.put<Lease>(key, { token: lease.token, expiresAt: Date.now() + LEASE_MS });
      await this.scheduleExpiry();
      try { socket.send(JSON.stringify({ type: "heartbeat-ack" })); } catch { /* closed */ }
      return;
    }
    if (!isRecord(body) || body.type !== "signal" ||
        body.target !== otherRole(attachment.role) || !validPayload(body.payload)) {
      try { socket.close(1008, "Invalid signaling message"); } catch { /* closed */ }
      return;
    }
    this.sendToRole(body.target, { type: "signal", payload: body.payload });
  }

  async webSocketClose(socket: WebSocket): Promise<void> { await this.release(socket); }
  async webSocketError(socket: WebSocket): Promise<void> { await this.release(socket); }
  private async release(socket: WebSocket): Promise<void> {
    const attachment = this.attachment(socket);
    if (!attachment) return;
    const key = "role:" + attachment.role;
    const lease = await this.state.storage.get<Lease>(key);
    if (lease?.token === attachment.token) await this.state.storage.delete(key);
    await this.scheduleExpiry();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const role of ["controller", "display"] as const) {
      const key = "role:" + role;
      const lease = await this.state.storage.get<Lease>(key);
      if (!lease || lease.expiresAt > now) continue;
      await this.state.storage.delete(key);
      for (const socket of this.state.getWebSockets?.() ?? []) {
        const attachment = this.attachment(socket);
        if (attachment?.role === role && attachment.token === lease.token) {
          try { socket.close(1001, "Session expired"); } catch { /* closed */ }
        }
      }
    }
    await this.scheduleExpiry();
  }

  private async scheduleExpiry(): Promise<void> {
    const leases = await Promise.all([
      this.state.storage.get<Lease>("role:controller"),
      this.state.storage.get<Lease>("role:display"),
    ]);
    const next = leases.filter((lease): lease is Lease => Boolean(lease))
      .reduce((earliest, lease) => Math.min(earliest, lease.expiresAt), Number.POSITIVE_INFINITY);
    if (Number.isFinite(next)) await this.state.storage.setAlarm(next);
    else await this.state.storage.deleteAlarm();
  }
}
