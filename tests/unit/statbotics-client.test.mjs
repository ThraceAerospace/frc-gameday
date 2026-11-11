import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTypeScriptModuleWithMocks } from "../helpers/load-typescript-with-mocks.mjs";

class FakeRedis {
  values = new Map();

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async set(key, value, ...options) {
    if (options.includes("NX") && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async del(key) {
    this.values.delete(key);
    return 1;
  }

  async eval(_script, _keyCount, key, token) {
    if (this.values.get(key) === token) {
      this.values.delete(key);
      return 1;
    }
    return 0;
  }
}

async function createClient() {
  const redis = new FakeRedis();
  const { StatboticsClient } = await loadTypeScriptModuleWithMocks(
    "src/lib/statbotics/client.ts",
    { "@/lib/cache/redis": { redis } },
  );
  return { client: new StatboticsClient(), redis };
}

function withGlobals({ fetch: fetchImplementation, baseUrl }, run) {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.STATBOTICS_API_BASE_URL;
  if (fetchImplementation) globalThis.fetch = fetchImplementation;
  if (baseUrl === null) delete process.env.STATBOTICS_API_BASE_URL;
  else if (baseUrl !== undefined) process.env.STATBOTICS_API_BASE_URL = baseUrl;

  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = originalFetch;
      if (originalBaseUrl === undefined) delete process.env.STATBOTICS_API_BASE_URL;
      else process.env.STATBOTICS_API_BASE_URL = originalBaseUrl;
    });
}

test("Statbotics client uses the configured API base and preserves encoded match keys", async () => {
  const { client, redis } = await createClient();
  let requestedUrl;
  const matchKey = "2026ctabc_qm 1";

  await withGlobals({
    baseUrl: "https://statbotics.test/",
    fetch: async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ key: matchKey, pred: { red_score: 100 } }), {
        status: 200,
        headers: { "Cache-Control": "max-age=60", ETag: '"stat-v1"' },
      });
    },
  }, async () => {
    const result = await client.getMatch(matchKey);
    assert.equal(result.key, matchKey);
  });

  assert.equal(requestedUrl, "https://statbotics.test/v3/match/2026ctabc_qm%201");
  const entries = [...redis.values.values()].map((value) => {
    try { return JSON.parse(value); } catch { return null; }
  }).filter((value) => value && typeof value === "object" && "fetchedAt" in value);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].etag, '"stat-v1"');
  assert.ok(entries[0].expiresAt - entries[0].fetchedAt >= 10 * 60 * 1000);
});

test("Statbotics 404 responses are cached as a real null result", async () => {
  const { client, redis } = await createClient();
  let requests = 0;

  await withGlobals({
    baseUrl: "https://statbotics.test",
    fetch: async () => {
      requests += 1;
      return new Response(null, {
        status: 404,
        headers: { "Cache-Control": "max-age=60" },
      });
    },
  }, async () => {
    assert.equal(await client.getMatch("2026ctabc_qm99"), null);
    assert.equal(await client.getMatch("2026ctabc_qm99"), null);
  });

  assert.equal(requests, 1);
  const entries = [...redis.values.values()].map((value) => {
    try { return JSON.parse(value); } catch { return null; }
  }).filter((value) => value && typeof value === "object" && "fetchedAt" in value);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].data, null);
});

test("Statbotics refresh failures return stale data and apply a bounded retry cooldown", async () => {
  const { client, redis } = await createClient();
  const endpoint = "/match/2026ctabc_qm1";
  const cacheKey = "cache:statbotics:v3::match:2026ctabc_qm1";
  const staleData = { key: "2026ctabc_qm1", pred: { red_score: 88 } };
  const now = Date.now();
  await redis.set(cacheKey, JSON.stringify({
    data: staleData,
    etag: '"stale"',
    fetchedAt: now - 900_000,
    lastRefreshAt: now - 900_000,
    expiresAt: now - 1,
  }));

  await withGlobals({
    baseUrl: "https://statbotics.test",
    fetch: async () => new Response("upstream unavailable", { status: 503 }),
  }, async () => {
    assert.deepEqual(await client.getMatch("2026ctabc_qm1", { refresh: true }), staleData);
  });

  const updated = JSON.parse(await redis.get(cacheKey));
  assert.deepEqual(updated.data, staleData);
  assert.ok(updated.lastRefreshAt >= now);
  assert.ok(updated.expiresAt > Date.now());
  assert.equal(await redis.get("lock:statbotics:v3::match:2026ctabc_qm1"), null);
  assert.equal(endpoint, "/match/2026ctabc_qm1");
});

test("Statbotics collection pagination uses stable filters and offsets", async () => {
  const { client } = await createClient();
  const requestedUrls = [];
  const firstPage = Array.from({ length: 1000 }, (_, index) => ({ key: `first-${index}` }));
  const secondPage = [{ key: "second-1" }, { key: "second-2" }];

  await withGlobals({
    baseUrl: "https://statbotics.test",
    fetch: async (url) => {
      requestedUrls.push(new URL(url));
      const offset = new URL(url).searchParams.get("offset");
      return new Response(JSON.stringify(offset === "0" ? firstPage : secondPage), {
        status: 200,
        headers: { "Cache-Control": "max-age=600" },
      });
    },
  }, async () => {
    const result = await client.getMatches({ event: "2026ctabc", year: 2026 });
    assert.equal(result.length, 1002);
    assert.equal(result[0].key, "first-0");
    assert.equal(result.at(-1).key, "second-2");
  });

  assert.equal(requestedUrls.length, 2);
  assert.equal(requestedUrls[0].searchParams.get("event"), "2026ctabc");
  assert.equal(requestedUrls[0].searchParams.get("year"), "2026");
  assert.equal(requestedUrls[0].searchParams.get("limit"), "1000");
  assert.equal(requestedUrls[0].searchParams.get("offset"), "0");
  assert.equal(requestedUrls[1].searchParams.get("offset"), "1000");
});
