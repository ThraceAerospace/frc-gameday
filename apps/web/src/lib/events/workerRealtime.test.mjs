import assert from "node:assert/strict";
import test from "node:test";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  readyState = FakeWebSocket.CONNECTING;
  listeners = new Map();
  sent = [];

  constructor(url) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, listener) {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open");
  }
  receive(data) {
    this.dispatch("message", { data });
  }
  send(message) { this.sent.push(message); }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close");
  }
}

test("SharedWorker runtime transport replays subscriptions and recovers versioned canonical snapshots", async () => {
  process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL = "https://runtime.example.test";
  globalThis.WebSocket = FakeWebSocket;
  globalThis.location = { protocol: "https:", host: "fieldview.example.test" };
  const fetchedVersions = [];
  const analyticsRevisions = [];
  const conditionalRequests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const validator = headers.get("If-None-Match");
    if (validator) conditionalRequests.push(validator);
    if (url.endsWith("/analytics")) {
      if (validator === 'W/"analytics-1"') {
        return new Response(null, { status: 304, headers: { ETag: validator } });
      }
      const revision = analyticsRevisions.length + 1;
      analyticsRevisions.push(revision);
      return Response.json({
        event_key: "2026test", revision, status: "succeeded",
        due_at: null, calculated_at: 1_000, source_revision: revision,
        publication: { marker: revision },
      }, { headers: { ETag: 'W/"analytics-1"' } });
    }
    if (validator === 'W/"snapshot-1"') {
      return new Response(null, { status: 304, headers: { ETag: validator } });
    }
    const version = fetchedVersions.length + 1;
    fetchedVersions.push(version);
    return Response.json(
      { event_key: "2026test", marker: version },
      { headers: {
        "X-FieldView-Snapshot-Version": String(version),
        ETag: 'W/"snapshot-1"',
      } },
    );
  };

  const { workerEventWebSocket } = await import("./workerRealtime.ts");
  const received = [];
  const analyticsReceived = [];
  workerEventWebSocket.retain();
  const unsubscribeFirst = workerEventWebSocket.subscribeCanonicalSnapshot(
    "2026test", (value) => received.push(value),
  );
  const unsubscribeSecond = workerEventWebSocket.subscribeCanonicalSnapshot(
    "2026test", (value) => received.push(value),
  );
  const unsubscribeAnalytics = workerEventWebSocket.subscribeCanonicalAnalytics(
    "2026test", (value) => analyticsReceived.push(value),
  );

  assert.equal(FakeWebSocket.instances.length, 1);
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, "wss://runtime.example.test/stream");
  socket.open();

  const subscriptions = socket.sent.map((message) => JSON.parse(message));
  assert.deepEqual(subscriptions, [
    { type: "subscribe", topic: "event-state", event_key: "2026test" },
    { type: "subscribe", topic: "analytics", event_key: "2026test" },
  ]);

  socket.receive(JSON.stringify({
    type: "subscribed",
    topic: "event-state",
    event_key: "2026test",
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received.at(-1).version, 1);
  socket.receive(JSON.stringify({
    type: "subscribed",
    topic: "analytics",
    event_key: "2026test",
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(analyticsReceived.at(-1).revision, 1);

  socket.receive(JSON.stringify({
    type: "snapshot.changed",
    topic: "event-state",
    event_key: "2026test",
    version: 2,
    etag: 'W/"snapshot-2"',
    data: { state: { event_key: "2026test", marker: 2 } },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received.at(-1).version, 2);
  socket.receive(JSON.stringify({
    type: "analytics.changed",
    topic: "analytics",
    event_key: "2026test",
    version: 2,
    etag: 'W/"analytics-2"',
    data: {
      event_key: "2026test", revision: 2, status: "succeeded",
      due_at: null, calculated_at: 2_000, source_revision: 2,
      publication: { marker: 2 },
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(analyticsReceived.at(-1).revision, 2);

  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(FakeWebSocket.instances.length, 2, "the shared socket reconnects after a disconnect");
  const reconnectedSocket = FakeWebSocket.instances[1];
  assert.equal(reconnectedSocket.url, "wss://runtime.example.test/stream");
  reconnectedSocket.open();
  assert.deepEqual(reconnectedSocket.sent.map((message) => JSON.parse(message)), [
    { type: "subscribe", topic: "event-state", event_key: "2026test" },
    { type: "subscribe", topic: "analytics", event_key: "2026test" },
  ], "active subscriptions replay after reconnect");
  reconnectedSocket.receive(JSON.stringify({
    type: "subscribed",
    topic: "event-state",
    event_key: "2026test",
  }));
  reconnectedSocket.receive(JSON.stringify({
    type: "subscribed",
    topic: "analytics",
    event_key: "2026test",
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received.at(-1).version, 2, "304 recovery keeps the locally cached snapshot");
  assert.equal(analyticsReceived.at(-1).revision, 2, "304 recovery keeps the locally cached analytics");
  assert.deepEqual(fetchedVersions, [1], "data-bearing publications avoid another snapshot read");
  assert.deepEqual(analyticsRevisions, [1], "data-bearing publications avoid another analytics read");
  assert.ok(conditionalRequests.includes('W/"snapshot-2"'));
  assert.ok(conditionalRequests.includes('W/"analytics-2"'));

  unsubscribeFirst();
  assert.equal(reconnectedSocket.sent.length, 2, "one remaining event listener and analytics subscriber keep both topics subscribed");
  unsubscribeSecond();
  unsubscribeAnalytics();
  assert.deepEqual(reconnectedSocket.sent.slice(-2).map((message) => JSON.parse(message)), [
    { type: "unsubscribe", topic: "event-state", event_key: "2026test" },
    { type: "unsubscribe", topic: "analytics", event_key: "2026test" },
  ]);
  workerEventWebSocket.release();
  assert.equal(reconnectedSocket.readyState, FakeWebSocket.CLOSED);
});
