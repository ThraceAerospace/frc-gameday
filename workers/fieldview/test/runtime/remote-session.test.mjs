import assert from "node:assert/strict";
import test from "node:test";
import { RemoteSessionRuntime } from "../../src/runtime/remote-session.ts";
class MemoryStorage {
  async get() { return undefined; }
  async put() { throw new Error("RemoteSessionRuntime must not persist session state"); }
  async delete() { throw new Error("RemoteSessionRuntime must not persist session state"); }
  async list() { return new Map(); }
  async transaction(callback) { return callback(this); }
  async setAlarm() { throw new Error("RemoteSessionRuntime must not schedule alarms"); }
  async deleteAlarm() { throw new Error("RemoteSessionRuntime must not schedule alarms"); }
}
class FakeSocket {
  sent = []; closed = false; attachment = null;
  send(value) { this.sent.push(value); }
  close(code, reason) { this.closed = true; this.closeCode = code; this.closeReason = reason; }
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return this.attachment; }
}
function fixture() {
  const storage = new MemoryStorage(), sockets = [], pairs = [];
  const runtime = new RemoteSessionRuntime({
    storage,
    acceptWebSocket(socket) { sockets.push(socket); },
    getWebSockets() { return sockets.filter((item) => !item.closed); },
  }, {
    webSocketPairFactory: () => { const pair = [new FakeSocket(), new FakeSocket()]; pairs.push(pair); return pair; },
    webSocketResponseFactory: () => new Response(null, { status: 200 }),
  });
  return { runtime, storage, sockets, pairs };
}
function request(role, token, code = "123456") {
  return new Request("https://runtime/connect?code=" + code + "&role=" + role, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": [
      "fieldview.remote.v1", "role." + role, "token." + token,
    ].join(", ") },
  });
}
test("remote sessions isolate signaling by pairing code and enforce role exclusivity", async () => {
  const { runtime, pairs } = fixture();
  await runtime.fetch(request("controller", "controller-token-123456"));
  const controller = pairs[0][1];
  assert.deepEqual(JSON.parse(controller.sent[0]), { type: "connected", role: "controller" });
  assert.equal((await runtime.fetch(request("controller", "other-controller-token"))).status, 409);
  await runtime.fetch(request("display", "display-token-123456"));
  const display = pairs[1][1];
  assert.equal(JSON.parse(controller.sent.at(-1)).type, "peer-ready");
  assert.equal(JSON.parse(display.sent.at(-1)).type, "peer-ready");
  const payload = { kind: "candidate", candidate: { candidate: "candidate:1" } };
  await runtime.webSocketMessage(controller, JSON.stringify({ type: "signal", target: "display", payload }));
  assert.deepEqual(JSON.parse(display.sent.at(-1)), { type: "signal", payload });
  assert.equal((await runtime.fetch(request("display", "another-display-token", "654321"))).status, 200);
  assert.equal(pairs[2][1].sent.length, 1);
});
test("closed sockets release a role without alarms, leases, or storage writes", async () => {
  const { runtime, sockets, pairs } = fixture();
  await runtime.fetch(request("controller", "controller-token-123456"));
  const controller = pairs[0][1];
  controller.close(1000, "normal close");
  assert.equal(sockets.length, 1);
  assert.equal((await runtime.fetch(request("controller", "new-controller-token-123"))).status, 200);
  assert.equal(pairs.length, 2);
});
test("remote sessions reject malformed credentials and signaling payloads", async () => {
  const { runtime, pairs } = fixture();
  assert.equal((await runtime.fetch(request("controller", "short", "bad"))).status, 400);
  assert.equal((await runtime.fetch(new Request("https://runtime/remote/ws?code=123456&role=controller", {
    headers: { Upgrade: "websocket" },
  }))).status, 401);
  await runtime.fetch(request("controller", "controller-token-123456"));
  const socket = pairs[0][1];
  await runtime.webSocketMessage(socket, JSON.stringify({
    type: "signal", target: "display", payload: { kind: "script", code: "not allowed" },
  }));
  assert.equal(socket.closed, true);
  assert.equal(socket.closeCode, 1008);
});
test("only accepted live sockets may send signaling messages", async () => {
  const { runtime, pairs } = fixture();
  await runtime.fetch(request("controller", "controller-token-123456"));
  const controller = pairs[0][1];
  controller.close(1000, "disconnected");
  await runtime.webSocketMessage(controller, JSON.stringify({
    type: "signal", target: "display",
    payload: { kind: "candidate", candidate: { candidate: "candidate:1" } },
  }));
  assert.equal(controller.closeCode, 1008);
});
