import assert from "node:assert/strict";
import test from "node:test";
import { Multiplexer } from "../../src/runtime/multiplexer.ts";

class MemoryStorage {
  values = new Map();
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async list({ prefix = "" } = {}) {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)));
  }
  async delete(key) { return this.values.delete(key); }
  async transaction(callback) { return callback(this); }
}

class FakeSocket {
  sent = [];
  closed = false;
  attachment = null;
  send(message) { this.sent.push(message); }
  close(code, reason) { this.closed = true; this.closeCode = code; this.closeReason = reason; }
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return this.attachment; }
}

test("one multiplexer deduplicates upstream event registration and filters per client", async () => {
  const storage = new MemoryStorage();
  const sockets = [];
  const pairs = [];
  const upstream = [];
  const state = {
    storage,
    acceptWebSocket(socket) { sockets.push(socket); },
    getWebSockets() { return sockets; },
  };
  const env = {
    RUNTIME_ADMIN_TOKEN: "service-secret",
    EVENT_RUNTIME: {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (request) => {
          const body = await request.json();
          upstream.push({ id, action: body.action, generation: body.generation });
          return Response.json({ registered: true });
        },
      }),
    },
    webSocketPairFactory: () => {
      const pair = [new FakeSocket(), new FakeSocket()];
      pairs.push(pair);
      return pair;
    },
    webSocketResponseFactory: () => new Response(null, { status: 200 }),
  };
  const mux = new Multiplexer(state, env);
  const connect = async () => {
    const response = await mux.fetch(new Request("https://mux/stream", {
      headers: { Upgrade: "websocket" },
    }));
    assert.equal(response.status, 200);
    return pairs.at(-1)[1];
  };
  const first = await connect();
  const second = await connect();
  const otherEvent = await connect();

  const subscribe = (socket, event_key) => mux.webSocketMessage(socket, JSON.stringify({
    type: "subscribe", topic: "event-state", event_key,
  }));
  await subscribe(first, "2026test");
  await subscribe(second, "2026test");
  await subscribe(otherEvent, "2026other");
  assert.deepEqual(upstream, [
    { id: "2026test", action: "subscribe", generation: 1 },
    { id: "2026test", action: "subscribe", generation: 2 },
    { id: "2026other", action: "subscribe", generation: 1 },
  ]);

  const notify = await mux.fetch(new Request("https://mux/internal/notify", {
    method: "POST",
    headers: { Authorization: "Bearer service-secret", "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol: 1, schema_version: 1, topic: "event-state",
      resource: "event-snapshot", change: "snapshot",
      event_key: "2026test", version: 7,
      data: { state: { event_key: "2026test", marker: "committed" } },
      etag: 'W/"event-7"',
    }),
  }));
  assert.deepEqual(await notify.json(), { delivered: 2 });
  const expected = {
    type: "snapshot.changed", protocol: 1, schema_version: 1,
    topic: "event-state", resource: "event-snapshot", change: "snapshot",
    event_key: "2026test", version: 7,
    data: { state: { event_key: "2026test", marker: "committed" } },
    etag: 'W/"event-7"',
  };
  assert.deepEqual(JSON.parse(first.sent.at(-1)), expected);
  assert.deepEqual(JSON.parse(second.sent.at(-1)), expected);
  assert.equal(otherEvent.sent.some((message) => {
    try { return JSON.parse(message).version === 7; } catch { return false; }
  }), false);

  await mux.webSocketMessage(first, JSON.stringify({
    type: "unsubscribe", topic: "event-state", event_key: "2026test",
  }));
  assert.deepEqual(upstream.at(-1), {
    id: "2026test", action: "subscribe", generation: 3,
  }, "registration remains active while another client is subscribed");
  await mux.webSocketClose(second);
  assert.deepEqual(upstream.at(-1), {
    id: "2026test", action: "unsubscribe", generation: 4,
  });
  assert.deepEqual(await storage.get("topic:event-state:2026test"), undefined);
});

test("multiplexer protects internal delivery and rejects malformed browser subscriptions", async () => {
  const storage = new MemoryStorage();
  const sockets = [];
  const pair = [new FakeSocket(), new FakeSocket()];
  const mux = new Multiplexer({
    storage,
    acceptWebSocket(socket) { sockets.push(socket); },
    getWebSockets() { return sockets; },
  }, {
    RUNTIME_ADMIN_TOKEN: "service-secret",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => Response.json({}) }) },
    webSocketPairFactory: () => pair,
    webSocketResponseFactory: () => new Response(null, { status: 200 }),
  });

  const unauthorized = await mux.fetch(new Request("https://mux/internal/notify", {
    method: "POST",
    body: JSON.stringify({ topic: "event-state", event_key: "2026test", version: 1 }),
  }));
  assert.equal(unauthorized.status, 401);

  await mux.fetch(new Request("https://mux/stream", { headers: { Upgrade: "websocket" } }));
  await mux.webSocketMessage(pair[1], JSON.stringify({
    type: "subscribe", topic: "event-state", event_key: "../bad",
  }));
  assert.equal(pair[1].closed, true);
  assert.equal(pair[1].closeCode, 1008);
});


test("analytics topic subscriptions receive independent publication revisions", async () => {
  const storage = new MemoryStorage();
  const sockets = [];
  const pair = [new FakeSocket(), new FakeSocket()];
  const mux = new Multiplexer({
    storage,
    acceptWebSocket(socket) { sockets.push(socket); },
    getWebSockets() { return sockets; },
  }, {
    RUNTIME_ADMIN_TOKEN: "service-secret",
    EVENT_RUNTIME: { idFromName: (name) => name, get: () => ({ fetch: async () => Response.json({}) }) },
    webSocketPairFactory: () => pair,
    webSocketResponseFactory: () => new Response(null, { status: 200 }),
  });
  await mux.fetch(new Request("https://mux/stream", { headers: { Upgrade: "websocket" } }));
  await mux.webSocketMessage(pair[1], JSON.stringify({
    type: "subscribe", topic: "analytics", event_key: "2026test",
  }));
  const notify = await mux.fetch(new Request("https://mux/internal/notify", {
    method: "POST",
    headers: { Authorization: "Bearer service-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ topic: "analytics", event_key: "2026test", version: 3 }),
  }));
  assert.deepEqual(await notify.json(), { delivered: 1 });
  assert.deepEqual(JSON.parse(pair[1].sent.at(-1)), {
    type: "analytics.changed", protocol: 1, schema_version: 1,
    topic: "analytics", resource: "event-analytics", change: "snapshot",
    event_key: "2026test", version: 3,
  });
  assert.equal(await storage.get("topic:analytics:2026test") instanceof Array, true);
});
