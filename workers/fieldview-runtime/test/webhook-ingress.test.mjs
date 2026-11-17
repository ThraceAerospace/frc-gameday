import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

async function sign(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, body);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function environment(onForward) {
  return {
    TBA_API_KEY: "api-key",
    TBA_WEBHOOK_SECRET: "webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: {
      idFromName: (name) => name,
      get: (id) => ({ fetch: onForward(id) }),
    },
  };
}

test("TBA webhook ingress verifies raw-body HMAC and routes to the event runtime", async () => {
  const raw = new TextEncoder().encode(JSON.stringify({
    message_type: "match_score",
    message_data: { event_key: "2026test", match: { key: "2026test_qm1" } },
  })).buffer;
  const signature = await sign("webhook-secret", raw);
  let forwarded = null;
  const env = environment(() => async (request) => {
    forwarded = request;
    return new Response("accepted", { status: 200 });
  });
  const response = await worker.fetch(new Request("https://runtime.test/webhooks/tba", {
    method: "POST",
    headers: { "X-TBA-HMAC": signature, "Content-Type": "application/json" },
    body: raw,
  }), env);
  assert.equal(response.status, 200);
  assert.equal(forwarded.headers.get("X-FieldView-Event-Key"), "2026test");
  assert.equal(forwarded.headers.get("Authorization"), "Bearer runtime-token");
  assert.equal(await forwarded.text(), new TextDecoder().decode(raw));
});

test("invalid TBA signatures are rejected before Durable Object routing", async () => {
  let called = false;
  const env = environment(() => async () => {
    called = true;
    return new Response("unexpected");
  });
  const response = await worker.fetch(new Request("https://runtime.test/webhooks/tba", {
    method: "POST",
    headers: { "X-TBA-HMAC": "0".repeat(64) },
    body: JSON.stringify({
      message_type: "match_score",
      message_data: { event_key: "2026test" },
    }),
  }), env);
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("TBA ping and verification notifications are acknowledged without event routing", async () => {
  let called = false;
  const env = environment(() => async () => {
    called = true;
    return new Response("unexpected");
  });
  const payloads = [
    { message_type: "ping", message_data: { title: "ping" } },
    { message_type: "verification", message_data: { verification_key: "abc" } },
  ];
  for (const payload of payloads) {
    const raw = new TextEncoder().encode(JSON.stringify(payload)).buffer;
    const signature = await sign("webhook-secret", raw);
    const response = await worker.fetch(new Request("https://runtime.test/webhooks/tba", {
      method: "POST", headers: { "X-TBA-HMAC": signature }, body: raw,
    }), env);
    assert.equal(response.status, 200);
  }
  assert.equal(called, false);
});
