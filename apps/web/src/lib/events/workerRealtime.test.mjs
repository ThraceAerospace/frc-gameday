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

test("SharedWorker recovers revision-only notices with read-only HTTP snapshot reads", async () => {
  process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL = "https://runtime.example.test";
  globalThis.WebSocket = FakeWebSocket;
  globalThis.location = { protocol: "https:", host: "fieldview.example.test" };
  const fetchedVersions = [];
  const analyticsRevisions = [];
  const requestOrder = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requestOrder.push(url);
    if (url.endsWith("/analytics")) {
      const revision = analyticsRevisions.length + 1;
      analyticsRevisions.push(revision);
      return Response.json({
        event_key: "2026test", revision, status: "succeeded",
        due_at: null, calculated_at: 1_000, source_revision: revision,
        publication: { marker: revision },
      }, { headers: { ETag: 'W/"analytics-1"' } });
    }
    const version = fetchedVersions.length === 0 ? 1 : 4;
    fetchedVersions.push(version);
    return Response.json(
      {
        event_key: "2026test",
        marker: version,
        teams: [{ key: "frc3461" }],
        team_states: [{ event_key: "2026test", team_key: "frc3461", marker: "initial" }],
      },
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

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requestOrder, [
    "https://runtime.example.test/events/2026test/snapshot",
    "https://runtime.example.test/events/2026test/analytics",
  ], "the canonical HTTP reads complete before the realtime connection is opened");
  assert.equal(received.at(-1).version, 1);
  assert.equal(analyticsReceived.at(-1).revision, 1);
  assert.equal(FakeWebSocket.instances.length, 1);
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, "wss://runtime.example.test/stream");
  socket.open();

  assert.deepEqual(socket.sent.map((message) => JSON.parse(message)), [
    { type: "subscribe", topic: "event-state", event_key: "2026test" },
    { type: "subscribe", topic: "analytics", event_key: "2026test" },
  ]);

  socket.receive(JSON.stringify({ type: "connected", protocol: 1, snapshot_required: true }));
  socket.receive(JSON.stringify({
    type: "subscribed", topic: "event-state", event_key: "2026test",
  }));
  socket.receive(JSON.stringify({
    type: "subscribed", topic: "analytics", event_key: "2026test",
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received.at(-1).version, 1);
  assert.equal(analyticsReceived.at(-1).revision, 1);

  socket.receive(JSON.stringify({
    type: "snapshot.changed",
    protocol: 1,
    schema_version: 1,
    topic: "event-state",
    resource: "event-snapshot",
    change: "snapshot",
    event_key: "2026test",
    version: 2,
    etag: 'W/"snapshot-2"',
    data: { state: { event_key: "2026test", marker: 2, teams: [{ key: "frc3461" }] } },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received.at(-1).version, 2);

  socket.receive(JSON.stringify({
    type: "snapshot.changed",
    protocol: 1,
    schema_version: 1,
    topic: "event-state",
    resource: "event-snapshot",
    change: "patch",
    event_key: "2026test",
    version: 3,
    etag: 'W/"snapshot-3"',
    data: {
      team_key: "frc3461",
      team_state: { event_key: "2026test", team_key: "frc3461", marker: "updated" },
      event_comparison_invalidated: true,
    },
  }));
  assert.equal(received.at(-1).version, 3);
  assert.equal(received.at(-1).complete, true,
    "team patches apply to an incomplete event snapshot without an HTTP refetch");
  assert.equal(received.at(-1).snapshot.state.marker, 2);
  assert.equal(received.at(-1).snapshot.team_states[0].team_key, "frc3461");

  socket.receive(JSON.stringify({
    type: "analytics.changed",
    protocol: 1,
    schema_version: 1,
    topic: "analytics",
    resource: "event-analytics",
    change: "snapshot",
    event_key: "2026test",
    version: 1,
    etag: 'W/"analytics-pending"',
    data: {
      event_key: "2026test", revision: 1, status: "pending",
      due_at: 2_000, calculated_at: 1_000, source_revision: 1,
      pending_invalidation: { sources: ["tba-event-matches"] },
      publication: { marker: 1 },
    },
  }));
  assert.equal(analyticsReceived.at(-1).status, "pending");

  socket.receive(JSON.stringify({
    type: "analytics.changed",
    protocol: 1,
    schema_version: 1,
    topic: "analytics",
    resource: "event-analytics",
    change: "snapshot",
    event_key: "2026test",
    version: 2,
    etag: 'W/"analytics-2"',
    data: {
      event_key: "2026test", revision: 2, status: "succeeded",
      due_at: null, calculated_at: 2_000, source_revision: 2,
      publication: { marker: 2 },
    },
  }));
  assert.equal(analyticsReceived.at(-1).revision, 2);

  socket.receive(JSON.stringify({
    type: "snapshot.changed",
    protocol: 1,
    schema_version: 1,
    topic: "event-state",
    resource: "event-snapshot",
    change: "snapshot",
    event_key: "2026test",
    version: 4,
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(fetchedVersions, [1, 4], "revision-only notices trigger one canonical HTTP snapshot read");
  assert.equal(received.at(-1).version, 4);
  assert.deepEqual(analyticsRevisions, [1], "WSS analytics notifications are data-bearing and never trigger HTTP reads");

  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(FakeWebSocket.instances.length, 2, "the shared socket reconnects after a disconnect");
  const reconnectedSocket = FakeWebSocket.instances[1];
  reconnectedSocket.open();
  assert.deepEqual(reconnectedSocket.sent.map((message) => JSON.parse(message)), [
    { type: "subscribe", topic: "event-state", event_key: "2026test" },
    { type: "subscribe", topic: "analytics", event_key: "2026test" },
  ], "active subscriptions replay after reconnect");
  reconnectedSocket.receive(JSON.stringify({
    type: "subscribed", topic: "event-state", event_key: "2026test",
  }));
  reconnectedSocket.receive(JSON.stringify({
    type: "subscribed", topic: "analytics", event_key: "2026test",
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(fetchedVersions, [1, 4], "reconnect does not trigger an additional snapshot read");
  assert.deepEqual(analyticsRevisions, [1], "reconnect does not trigger a WSS-driven analytics refetch");

  unsubscribeFirst();
  unsubscribeSecond();
  unsubscribeAnalytics();
  workerEventWebSocket.release();
  assert.equal(reconnectedSocket.readyState, FakeWebSocket.CLOSED);
});
