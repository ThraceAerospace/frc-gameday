import assert from "node:assert/strict";
import test from "node:test";
import { FRCColorsApiClient } from "../src/client.ts";
import { FRC_COLORS_ENDPOINTS } from "../src/endpoints.ts";

test("builds encoded FRC Colors event paths", () => {
  assert.equal(FRC_COLORS_ENDPOINTS.event("2026test/event"), "/event/2026test%2Fevent");
});

test("returns the native provider response without parsing or changing it", async () => {
  let captured;
  const response = new Response('{"teams":{"3461":{"colors":{"primaryHex":"#abcdef"}}}}', {
    status: 200,
    headers: { ETag: '"colors-v1"', "Content-Type": "application/json" },
  });
  const client = new FRCColorsApiClient({
    baseUrl: "https://colors.example.test/v1/",
    fetch: async (url, init) => {
      captured = { url, init };
      return response;
    },
  });

  const result = await client.request(FRC_COLORS_ENDPOINTS.event("2026test"), {
    headers: { "If-None-Match": '"colors-v0"' },
  });

  assert.equal(captured.url, "https://colors.example.test/v1/event/2026test");
  assert.equal(new Headers(captured.init.headers).get("If-None-Match"), '"colors-v0"');
  assert.equal(captured.init.cache, "no-store");
  assert.equal(result, response);
  assert.equal(result.headers.get("ETag"), '"colors-v1"');
  assert.equal(await result.text(), '{"teams":{"3461":{"colors":{"primaryHex":"#abcdef"}}}}');
});

test("rejects absolute and protocol-relative endpoint paths", () => {
  const client = new FRCColorsApiClient({ fetch: async () => new Response() });
  assert.throws(() => client.request("https://example.test/event/2026test"), /provider-relative/);
  assert.throws(() => client.request("//example.test/event/2026test"), /provider-relative/);
});

test("returns non-success provider responses unchanged", async () => {
  const response = new Response("temporarily unavailable", {
    status: 502,
    headers: { "Retry-After": "15" },
  });
  const client = new FRCColorsApiClient({ fetch: async () => response });

  const result = await client.request(FRC_COLORS_ENDPOINTS.event("2026test"));

  assert.equal(result, response);
  assert.equal(result.status, 502);
  assert.equal(result.headers.get("Retry-After"), "15");
  assert.equal(await result.text(), "temporarily unavailable");
});

test("preserves malformed provider payloads for the application boundary to handle", async () => {
  const response = new Response("{not-json", { status: 200 });
  const client = new FRCColorsApiClient({ fetch: async () => response });

  const result = await client.request(FRC_COLORS_ENDPOINTS.event("2026test"));

  assert.equal(result, response);
  assert.equal(await result.text(), "{not-json");
});

test("propagates network failures without fabricating an empty color result", async () => {
  const failure = new TypeError("upstream connection failed");
  const client = new FRCColorsApiClient({ fetch: async () => { throw failure; } });

  await assert.rejects(
    client.request(FRC_COLORS_ENDPOINTS.event("2026test")),
    (error) => error === failure,
  );
});
