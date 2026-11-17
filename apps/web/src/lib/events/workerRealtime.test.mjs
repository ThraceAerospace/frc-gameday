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
  globalThis.fetch = async () => {
    const version = fetchedVersions.length + 1;
    fetchedVersions.push(version);
    return Response.json(
      { event_key: "2026test", marker: version },
      { headers: { "X-FieldView-Snapshot-Version": String(version) } },
    );
  };

  const { workerEventWebSocket } = await import("../src/lib/events/workerRealtime.ts");
  const received = [];
  workerEventWebSocket.retain();
  const unsubscribeFirst = workerEventWebSocket.subscribeCanonicalSnapshot(
    "2026test", (value) => received.push(value),
  );
  const unsubscribeSecond = workerEventWebSocket.subscribeCanonicalSnapshot(
    "2026test", (value) => received.push(value),
  );

  assert.equal(FakeWebSocket.instances.length, 1);
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, "wss://runtime.example.test/stream");
  socket.open();

  const subscriptions = socket.sent.map((message) => JSON.parse(message));
  assert.deepEqual(subscriptions, [{
    type: "subscribe",
    topic: "event-state",
    event_key: "2026test",
  }]);

  socket.receive(JSON.stringify({
    type: "subscribed",
    topic: "event-state",
    event_key: "2026test",
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received.at(-1).version, 1);

  socket.receive(JSON.stringify({
    type: "snapshot.changed",
    topic: "event-state",
    event_key: "2026test",
    version: 2,
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received.at(-1).version, 2);
  assert.deepEqual(fetchedVersions, [1, 2]);

  unsubscribeFirst();
  assert.equal(socket.sent.length, 1, "one remaining listener keeps the shared topic subscribed");
  unsubscribeSecond();
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), {
    type: "unsubscribe",
    topic: "event-state",
    event_key: "2026test",
  });
  workerEventWebSocket.release();
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
});
