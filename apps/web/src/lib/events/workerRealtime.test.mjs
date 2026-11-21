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
      if (validator?.startsWith('W/"analytics-')) {
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
    if (validator?.startsWith('W/"snapshot-')) {
      return new Response(null, { status: 304, headers: { ETag: validator } });
    }
    const version = fetchedVersions.length + 1;
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
    "a contiguous team-only delta keeps a complete cached event snapshot complete");
  assert.equal(received.at(-1).snapshot.state.marker, 2,
    "a team-only delta retains the unchanged event-owned state");
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
  assert.equal(analyticsReceived.at(-1).status, "pending",
    "a changed validator applies status updates even when the calculation revision is unchanged");

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
  assert.equal(received.at(-1).version, 3, "304 recovery keeps the locally cached snapshot");
  assert.equal(analyticsReceived.at(-1).revision, 2, "304 recovery keeps the locally cached analytics");
  assert.deepEqual(fetchedVersions, [1], "data-bearing publications avoid another snapshot read");
  assert.deepEqual(analyticsRevisions, [1], "data-bearing publications avoid another analytics read");
  assert.ok(conditionalRequests.includes('W/"snapshot-3"'));
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


test("SharedWorker hydrates canonical snapshots from IndexedDB before reconnect recovery", async () => {
  process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL = "https://runtime.example.test";
  globalThis.WebSocket = FakeWebSocket;
  globalThis.location = { protocol: "https:", host: "fieldview.example.test" };
  const records = new Map();
  globalThis.self = globalThis;
  globalThis.indexedDB = {
    open() {
      const request = {};
      const database = {
        objectStoreNames: { contains: () => true },
        createObjectStore() {},
        transaction() {
          const transaction = {};
          transaction.objectStore = () => ({
            get(key) {
              const result = {};
              queueMicrotask(() => {
                result.result = records.get(key);
                result.onsuccess?.();
              });
              return result;
            },
            put(value) {
              records.set(value.key, structuredClone(value));
              queueMicrotask(() => transaction.oncomplete?.());
            },
          });
          return transaction;
        },
      };
      queueMicrotask(() => {
        request.result = database;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };

  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return Response.json(
      { event_key: "2026cache", marker: "persisted", teams: [], team_states: [] },
      { headers: {
        "X-FieldView-Snapshot-Version": "7",
        ETag: 'W/"snapshot-cache-7"',
      } },
    );
  };

  const firstModule = await import("./workerRealtime.ts?indexeddb-writer");
  const firstWorker = firstModule.workerEventWebSocket;
  firstWorker.retain();
  const firstValues = [];
  const unsubscribeFirst = firstWorker.subscribeCanonicalSnapshot("2026cache", (value) => firstValues.push(value));
  const firstSocket = FakeWebSocket.instances.at(-1);
  firstSocket.open();
  firstSocket.receive(JSON.stringify({
    type: "subscribed", topic: "event-state", event_key: "2026cache",
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(firstValues.at(-1).version, 7);
  assert.equal(firstValues.at(-1).complete, true);
  assert.ok(records.has("snapshot:2026cache"));
  unsubscribeFirst();
  firstWorker.release();

  const secondModule = await import("./workerRealtime.ts?indexeddb-reader");
  const secondWorker = secondModule.workerEventWebSocket;
  const restoredValues = [];
  secondWorker.retain();
  const unsubscribeSecond = secondWorker.subscribeCanonicalSnapshot("2026cache", (value) => restoredValues.push(value));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(restoredValues.at(-1).version, 7);
  assert.equal(restoredValues.at(-1).snapshot.state.marker, "persisted");
  assert.equal(fetchCount, 1, "hydration serves the persisted representation without an immediate network read");
  unsubscribeSecond();
  secondWorker.release();
  delete globalThis.indexedDB;
  delete globalThis.self;
});
