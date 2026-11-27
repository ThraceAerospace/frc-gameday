import { DurableObjectBase } from "./durable-object-base.ts";
import type { DurableObjectStateLike, RuntimeEnvironment } from "./cloudflare.ts";

type Topic = "event-state" | "analytics";
type Subscription = { topic: Topic; event_key: string };
type SocketAttachment = { clientId: string };

const EVENT_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;
const CLIENT_PREFIX = "client:";
const TOPIC_PREFIX = "topic:";
const REGISTRATION_PREFIX = "registration-generation:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function subscriptionKey(subscription: Subscription): string {
  return TOPIC_PREFIX + subscription.topic + ":" + subscription.event_key;
}
function sameSubscription(a: Subscription, b: Subscription): boolean {
  return a.topic === b.topic && a.event_key === b.event_key;
}

/**
 * One shared browser WebSocket multiplexer. It owns connection and subscription
 * routing only; EventRuntime and the analytics publisher own canonical data.
 */
export class Multiplexer extends DurableObjectBase {
  private readonly state: DurableObjectStateLike;
  private readonly env: RuntimeEnvironment;

  constructor(state: DurableObjectStateLike, env: RuntimeEnvironment) {
    super(state, env);
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/stream" && request.method === "GET") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return Response.json({ error: "WebSocket upgrade required" }, { status: 426 });
      }
      if (!this.state.acceptWebSocket) {
        return Response.json({ error: "WebSocket subscriptions are unavailable" }, { status: 501 });
      }
      const pair = this.env.webSocketPairFactory
        ? this.env.webSocketPairFactory()
        : new (globalThis as typeof globalThis & {
          WebSocketPair: new () => { 0: WebSocket; 1: WebSocket };
        }).WebSocketPair();
      const clientId = crypto.randomUUID();
      const server = pair[1] as WebSocket & {
        serializeAttachment?: (value: unknown) => void;
      };
      server.serializeAttachment?.({ clientId } satisfies SocketAttachment);
      this.state.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "connected", protocol: 1 }));
      return this.env.webSocketResponseFactory
        ? this.env.webSocketResponseFactory(pair[0])
        : new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit & { webSocket: WebSocket });
    }

    if (url.pathname === "/state" && request.method === "GET") {
      if (!this.authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const clients = await this.state.storage.list<Subscription[]>({ prefix: CLIENT_PREFIX });
      const topics = await this.state.storage.list<string[]>({ prefix: TOPIC_PREFIX });
      return Response.json({
        connected_sockets: this.state.getWebSockets?.().length ?? null,
        clients: clients.size,
        subscriptions: [...topics.entries()].map(([key, ids]) => ({ topic: key.slice(TOPIC_PREFIX.length), clients: ids.length })),
      });
    }

    if (url.pathname === "/internal/notify" && request.method === "POST") {
      if (!this.authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) ||
          (body.topic !== "event-state" && body.topic !== "analytics") ||
          typeof body.event_key !== "string" || !EVENT_KEY_PATTERN.test(body.event_key) ||
          !Number.isSafeInteger(body.version) || (body.version as number) < 0 ||
          (body.data !== undefined && !isRecord(body.data)) ||
          (body.etag !== undefined && typeof body.etag !== "string") ||
          (body.protocol !== undefined && body.protocol !== 1) ||
          (body.schema_version !== undefined && body.schema_version !== 1) ||
          (body.change !== undefined && body.change !== "snapshot" && body.change !== "patch") ||
          (body.resource !== undefined && typeof body.resource !== "string")) {
        return Response.json({ error: "Invalid notification" }, { status: 400 });
      }
      const subscription: Subscription = { topic: body.topic, event_key: body.event_key };
      const clients = await this.state.storage.get<string[]>(subscriptionKey(subscription)) ?? [];
      const message = JSON.stringify({
        type: body.topic === "event-state" ? "snapshot.changed" : "analytics.changed",
        protocol: 1,
        schema_version: 1,
        topic: body.topic,
        resource: typeof body.resource === "string"
          ? body.resource
          : body.topic === "event-state" ? "event-snapshot" : "event-analytics",
        change: body.change === "patch" ? "patch" : "snapshot",
        event_key: body.event_key,
        version: body.version,
        ...(isRecord(body.data) ? { data: body.data } : {}),
        ...(typeof body.etag === "string" ? { etag: body.etag } : {}),
      });
      const wanted = new Set(clients);
      let delivered = 0;
      for (const socket of this.state.getWebSockets?.() ?? []) {
        const attachment = (socket as WebSocket & {
          deserializeAttachment?: () => unknown;
        }).deserializeAttachment?.();
        if (!isRecord(attachment) || typeof attachment.clientId !== "string" ||
            !wanted.has(attachment.clientId)) continue;
        try { socket.send(message); delivered += 1; }
        catch { try { socket.close(1011, "Notification delivery failed"); } catch { /* already closed */ } }
      }
      return Response.json({ delivered });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private authorized(request: Request): boolean {
    return Boolean(this.env.RUNTIME_ADMIN_TOKEN) &&
      request.headers.get("Authorization") === "Bearer " + this.env.RUNTIME_ADMIN_TOKEN;
  }

  private clientId(socket: WebSocket): string | null {
    const attachment = (socket as WebSocket & {
      deserializeAttachment?: () => unknown;
    }).deserializeAttachment?.();
    return isRecord(attachment) && typeof attachment.clientId === "string"
      ? attachment.clientId : null;
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") {
      try { socket.send("pong"); } catch { /* closed */ }
      return;
    }
    let body: unknown;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      body = JSON.parse(text);
    } catch {
      try { socket.close(1008, "Invalid subscription message"); } catch { /* closed */ }
      return;
    }
    if (!isRecord(body) || (body.type !== "subscribe" && body.type !== "unsubscribe") ||
        (body.topic !== "event-state" && body.topic !== "analytics") ||
        typeof body.event_key !== "string" || !EVENT_KEY_PATTERN.test(body.event_key)) {
      try { socket.close(1008, "Invalid subscription message"); } catch { /* closed */ }
      return;
    }
    const clientId = this.clientId(socket);
    if (!clientId) {
      try { socket.close(1011, "Missing connection identity"); } catch { /* closed */ }
      return;
    }
    const subscription: Subscription = { topic: body.topic, event_key: body.event_key };
    if (body.type === "subscribe") {
      const result = await this.addSubscription(clientId, subscription);
      if (!result.ok) {
        try { socket.send(JSON.stringify({ type: "subscription.error", ...subscription })); } catch { /* closed */ }
        return;
      }
      try { socket.send(JSON.stringify({ type: "subscribed", ...subscription })); } catch { /* closed */ }
    } else {
      await this.removeSubscription(clientId, subscription);
      try { socket.send(JSON.stringify({ type: "unsubscribed", ...subscription })); } catch { /* closed */ }
    }
  }

  private async addSubscription(
    clientId: string,
    subscription: Subscription,
  ): Promise<{ ok: boolean }> {
    const changed = await this.state.storage.transaction(async (tx) => {
      const clientKey = CLIENT_PREFIX + clientId;
      const current = await tx.get<Subscription[]>(clientKey) ?? [];
      if (current.some((item) => sameSubscription(item, subscription))) {
        return { added: false, generation: 0 };
      }
      const topicKey = subscriptionKey(subscription);
      const clients = await tx.get<string[]>(topicKey) ?? [];
      await tx.put(clientKey, [...current, subscription]);
      await tx.put(topicKey, [...clients, clientId]);
      const generationKey = REGISTRATION_PREFIX + subscriptionKey(subscription);
      const generation = (await tx.get<number>(generationKey) ?? 0) + 1;
      await tx.put(generationKey, generation);
      return { added: true, generation };
    });
    if (!changed.added) return { ok: true };
    const response = await this.syncRuntimeSubscription(
      subscription.topic, subscription.event_key, true, changed.generation,
    );
    if (!response) {
      await this.removeSubscription(clientId, subscription);
      return { ok: false };
    }
    return { ok: true };
  }

  private async removeSubscription(clientId: string, subscription: Subscription): Promise<void> {
    const changed = await this.state.storage.transaction(async (tx) => {
      const clientKey = CLIENT_PREFIX + clientId;
      const current = await tx.get<Subscription[]>(clientKey) ?? [];
      const next = current.filter((item) => !sameSubscription(item, subscription));
      if (next.length === current.length) return { removed: false, desired: false, generation: 0 };
      if (next.length) await tx.put(clientKey, next);
      else await tx.delete(clientKey);
      const topicKey = subscriptionKey(subscription);
      const clients = (await tx.get<string[]>(topicKey) ?? []).filter((id) => id !== clientId);
      if (clients.length) await tx.put(topicKey, clients);
      else await tx.delete(topicKey);
      const generationKey = REGISTRATION_PREFIX + subscriptionKey(subscription);
      const generation = (await tx.get<number>(generationKey) ?? 0) + 1;
      await tx.put(generationKey, generation);
      return { removed: true, desired: clients.length > 0, generation };
    });
    if (changed.removed) {
      await this.syncRuntimeSubscription(
        subscription.topic, subscription.event_key, changed.desired, changed.generation,
      );
    }
  }

  private async syncRuntimeSubscription(
    topic: Topic,
    eventKey: string,
    registered: boolean,
    generation: number,
  ): Promise<boolean> {
    const runtime = this.env.EVENT_RUNTIME;
    if (!runtime || !this.env.RUNTIME_ADMIN_TOKEN) return false;
    const response = await runtime.get(runtime.idFromName(eventKey)).fetch(
      new Request("https://event-runtime/subscriptions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
          "X-FieldView-Event-Key": eventKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: registered ? "subscribe" : "unsubscribe",
          topic,
          generation,
        }),
      }),
    ).catch(() => null);
    return Boolean(response?.ok);
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.cleanupSocket(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.cleanupSocket(socket);
  }

  private async cleanupSocket(socket: WebSocket): Promise<void> {
    const clientId = this.clientId(socket);
    if (!clientId) return;
    const subscriptions = await this.state.storage.get<Subscription[]>(CLIENT_PREFIX + clientId) ?? [];
    for (const subscription of subscriptions) {
      await this.removeSubscription(clientId, subscription);
    }
  }
}
