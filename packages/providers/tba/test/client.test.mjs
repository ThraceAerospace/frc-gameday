import assert from "node:assert/strict";
import test from "node:test";

import { TBAApiClient } from "../src/client.ts";

test("adds TBA authentication while preserving caller headers", async () => {
  let request;
  const client = new TBAApiClient({
    apiKey: "test-api-key",
    fetch: async (input, init) => {
      request = { input, init };
      return new Response("{}", { status: 200 });
    },
  });

  const response = await client.request("/event/2026test");

  assert.equal(response.status, 200);
  assert.equal(request.input, "https://www.thebluealliance.com/api/v3/event/2026test");
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get("X-TBA-Auth-Key"), "test-api-key");
  assert.equal(request.init.cache, "no-store");
});

test("preserves conditional request headers", async () => {
  let requestHeaders;
  const client = new TBAApiClient({
    apiKey: "test-api-key",
    fetch: async (_input, init) => {
      requestHeaders = new Headers(init.headers);
      return new Response(null, { status: 304 });
    },
  });

  const response = await client.request("/match/2026test_qm1", {
    headers: { "If-None-Match": '"cached-version"' },
  });

  assert.equal(response.status, 304);
  assert.equal(requestHeaders.get("If-None-Match"), '"cached-version"');
  assert.equal(requestHeaders.get("X-TBA-Auth-Key"), "test-api-key");
});

test("supports an injected base URL and fetch implementation", async () => {
  let requestedUrl;
  const client = new TBAApiClient({
    apiKey: "test-api-key",
    baseUrl: "https://tba.example.test/api/v3///",
    fetch: async (input) => {
      requestedUrl = input;
      return new Response("{}", { status: 200 });
    },
  });

  await client.request("/team/frc3461");
  assert.equal(requestedUrl, "https://tba.example.test/api/v3/team/frc3461");
});

test("rejects absolute and non-provider-relative endpoints", async () => {
  let fetchCalled = false;
  const client = new TBAApiClient({
    apiKey: "test-api-key",
    fetch: async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(client.request("event/2026test"), /provider-relative path/);
  await assert.rejects(client.request("//attacker.example/path"), /provider-relative path/);
  await assert.rejects(client.request("https://attacker.example/path"), /provider-relative path/);
  assert.equal(fetchCalled, false);
});
