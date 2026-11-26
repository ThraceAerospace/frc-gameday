import assert from "node:assert/strict";
import test from "node:test";
import { RemoteSessionRuntime } from "../../src/runtime/remote-session.ts";

class MemoryStorage {
  values = new Map();
  alarmAt = null;
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  async list() { return new Map(this.values); }
  async transaction(callback) { return callback(this); }
  async setAlarm(at) { this.alarmAt = Number(at); }
  async deleteAlarm() { this.alarmAt = null; }
}
class FakeSocket {
  sent = [];
  closed = false;
  attachment = null;
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
    getWebSockets() { return sockets; },
  }, {
    webSocketPairFactory: () => {
      const pair = [new FakeSocket(), new FakeSocket()];
      pairs.push(pair);
      return pair;
    },
    webSocketResponseFactory: () => new Response(null, { status: 200 }),
  });
  return { runtime, storage, sockets, pairs };
}
function connectRequest(role, token, code = "123456") {
  return new Request("https://runtime/remote/ws?code=" + code + "&role=" + role, {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": ["fieldview.remote.v1", "role." + role, "token." + token].join(", "),
    },
  });
}

test("remote sessions isolate signaling by pairing code and role", async () => {
  const { runtime, storage, pairs } = fixture();
  await runtime.fetch(connectRequest("controller", "controller-token-123456"));
  const controller = pairs[0][1];
  assert.deepEqual(JSON.parse(controller.sent[0]), { type: "connected", role: "controller" });
  assert.equal((await runtime.fetch(connectRequest("controller", "other-controller-token"))).status, 409);
  await runtime.fetch(connectRequest("display", "display-token-123456"));
  const display = pairs[1][1];
  assert.equal(JSON.parse(controller.sent.at(-1)).type, "peer-ready");
  assert.equal(JSON.parse(display.sent.at(-1)).type, "peer-ready");

  const payload = { kind: "candidate", candidate: { candidate: "candidate:1" } };
  await runtime.webSocketMessage(controller, JSON.stringify({ type: "signal", target: "display", payload }));
  assert.deepEqual(JSON.parse(display.sent.at(-1)), { type: "signal", payload });
  assert.ok(await storage.get("role:controller"));
  assert.equal((await runtime.fetch(connectRequest("display", "different-display-token", "654321"))).status, 200);
  assert.equal(pairs[2][1].sent.length, 1, "another pairing code has an independent session");
});

test("heartbeat renews presence and alarm expires abandoned role leases", async () => {
  const { runtime, storage, pairs } = fixture();
  await runtime.fetch(connectRequest("controller", "controller-token-123456"));
  const socket = pairs[0][1];
  const before = await storage.get("role:controller");
  await runtime.webSocketMessage(socket, JSON.stringify({ type: "heartbeat" }));
  const after = await storage.get("role:controller");
  assert.ok(after.expiresAt >= before.expiresAt);
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { type: "heartbeat-ack" });

  await storage.put("role:controller", { token: "controller-token-123456", expiresAt: Date.now() - 1 });
  await runtime.alarm();
  assert.equal(socket.closed, true);
  assert.equal(await storage.get("role:controller"), undefined);
  assert.equal((await runtime.fetch(connectRequest("controller", "new-controller-token-123"))).status, 200);
});

test("remote sessions reject invalid credentials and signaling payloads", async () => {
  const { runtime, pairs } = fixture();
  assert.equal((await runtime.fetch(connectRequest("controller", "short", "bad"))).status, 400);
  assert.equal((await runtime.fetch(new Request("https://runtime/remote/ws?code=123456&role=controller", {
    headers: { Upgrade: "websocket" },
  }))).status, 401);
  await runtime.fetch(connectRequest("controller", "controller-token-123456"));
  const socket = pairs[0][1];
  await runtime.webSocketMessage(socket, JSON.stringify({
    type: "signal", target: "display", payload: { kind: "script", code: "not allowed" },
  }));
  assert.equal(socket.closed, true);
  assert.equal(socket.closeCode, 1008);
});
