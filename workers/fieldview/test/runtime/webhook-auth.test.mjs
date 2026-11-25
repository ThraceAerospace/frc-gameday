import assert from "node:assert/strict";
import test from "node:test";
import { verifyTbaWebhookHmac } from "../../src/runtime/webhook-auth.ts";

async function sign(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, body);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("accepts TBA HMAC-SHA256 over exact raw payload bytes", async () => {
  const secret = "example-long-webhook-secret";
  const body = new TextEncoder().encode('{"message_type":"ping","message_data":{"title":"ok"}}').buffer;
  const signature = await sign(secret, body);
  assert.equal(await verifyTbaWebhookHmac(secret, signature, body), true);
});

test("rejects altered payloads, wrong secrets, and malformed signatures", async () => {
  const secret = "example-long-webhook-secret";
  const body = new TextEncoder().encode('{"message_type":"ping"}').buffer;
  const signature = await sign(secret, body);
  const altered = new TextEncoder().encode('{"message_type":"ping " }').buffer;
  assert.equal(await verifyTbaWebhookHmac(secret, signature, altered), false);
  assert.equal(await verifyTbaWebhookHmac("wrong-secret", signature, body), false);
  assert.equal(await verifyTbaWebhookHmac(secret, "sha256=" + signature, body), false);
  assert.equal(await verifyTbaWebhookHmac(secret, "not-a-signature", body), false);
  assert.equal(await verifyTbaWebhookHmac(secret, null, body), false);
});
