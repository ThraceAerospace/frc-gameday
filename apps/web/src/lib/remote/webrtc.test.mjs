import assert from "node:assert/strict";
import test from "node:test";
import { RemotePeer } from "./webrtc.ts";

test("remote peer fails closed when the Worker runtime URL is not configured", () => {
  const previousRuntimeUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  const previousWebSocket = globalThis.WebSocket;
  delete process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;

  let websocketConstructed = false;
  globalThis.WebSocket = class {
    constructor() {
      websocketConstructed = true;
    }
  };

  const peerStatuses = [];
  const signalingStatuses = [];
  try {
    const peer = new RemotePeer({
      code: "123456",
      role: "controller",
      onStatus: (status) => peerStatuses.push(status),
      onSignalingStatus: (status) => signalingStatuses.push(status),
    });

    peer.start();

    assert.equal(websocketConstructed, false);
    assert.deepEqual(peerStatuses, ["error"]);
    assert.deepEqual(signalingStatuses, ["error"]);
  } finally {
    if (previousRuntimeUrl === undefined) {
      delete process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
    } else {
      process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL = previousRuntimeUrl;
    }
    globalThis.WebSocket = previousWebSocket;
  }
});

test("remote peer fails closed for an invalid Worker runtime URL", () => {
  const previousRuntimeUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  const previousWebSocket = globalThis.WebSocket;
  process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL = "file:///tmp/runtime";

  let websocketConstructed = false;
  globalThis.WebSocket = class {
    constructor() {
      websocketConstructed = true;
    }
  };

  const peerStatuses = [];
  const signalingStatuses = [];
  try {
    const peer = new RemotePeer({
      code: "123456",
      role: "display",
      onStatus: (status) => peerStatuses.push(status),
      onSignalingStatus: (status) => signalingStatuses.push(status),
    });

    peer.start();

    assert.equal(websocketConstructed, false);
    assert.deepEqual(peerStatuses, ["error"]);
    assert.deepEqual(signalingStatuses, ["error"]);
  } finally {
    if (previousRuntimeUrl === undefined) {
      delete process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
    } else {
      process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL = previousRuntimeUrl;
    }
    globalThis.WebSocket = previousWebSocket;
  }
});
