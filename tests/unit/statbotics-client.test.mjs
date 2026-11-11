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

test("Statbotics defaults to the official API when no override is configured", async () => {
  const { client } = await createClient();
  let requestedUrl;

  await withGlobals({
    baseUrl: null,
    fetch: async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ key: "2026ctabc_qm-default" }), {
        status: 200,
        headers: { "Cache-Control": "max-age=60" },
      });
    },
  }, async () => {
    const result = await client.getMatch("2026ctabc_qm-default");
    assert.equal(result.key, "2026ctabc_qm-default");
  });

  assert.equal(requestedUrl, "https://api.statbotics.io/v3/match/2026ctabc_qm-default");
});

test("temporary Chondl override preserves encoded match keys", async () => {
  const { client, redis } = await createClient();
  let requestedUrl;
  const matchKey = "2026ctabc_qm 1";

  await withGlobals({
    baseUrl: "https://api-statbotics.popcornpenguins.com/",
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

  assert.equal(requestedUrl, "https://api-statbotics.popcornpenguins.com/v3/match/2026ctabc_qm%201");
  const entries = [...redis.values.values()].map((value) => {
    try { return JSON.parse(value); } catch { return null; }
  }).filter((value) => value && typeof value === "object" && "fetchedAt" in value);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].etag, '"stat-v1"');
  assert.ok(entries[0].expiresAt - entries[0].fetchedAt >= 10 * 60 * 1000);
});

test("Statbotics client uses the documented v3 team and collection routes", async () => {
  const { client } = await createClient();
  const requestedUrls = [];

  await withGlobals({
    baseUrl: "https://api-statbotics.popcornpenguins.com",
    fetch: async (url) => {
      requestedUrls.push(new URL(url));
      const pathname = new URL(url).pathname;
      const body = pathname.endsWith("/matches") || pathname.endsWith("/team_events")
        ? []
        : { team: 3461, year: 2026, event: "2026ctabc" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Cache-Control": "max-age=60" },
      });
    },
  }, async () => {
    assert.equal((await client.getTeamYear(3461, 2026)).team, 3461);
    assert.equal((await client.getTeamEvent(3461, "2026ctabc")).event, "2026ctabc");
    assert.deepEqual(await client.getMatches({ event: "2026ctabc", year: 2026, elim: false }), []);
    assert.deepEqual(await client.getTeamEvents({ team: 3461, year: 2026 }), []);
  });

  assert.deepEqual(requestedUrls.map((url) => url.pathname), [
    "/v3/team_year/3461/2026",
    "/v3/team_event/3461/2026ctabc",
    "/v3/matches",
    "/v3/team_events",
  ]);
  assert.equal(requestedUrls[2].searchParams.get("event"), "2026ctabc");
  assert.equal(requestedUrls[2].searchParams.get("year"), "2026");
  assert.equal(requestedUrls[2].searchParams.get("elim"), "false");
  assert.equal(requestedUrls[2].searchParams.get("limit"), "1000");
  assert.equal(requestedUrls[2].searchParams.get("offset"), "0");
  assert.equal(requestedUrls[3].searchParams.get("team"), "3461");
  assert.equal(requestedUrls[3].searchParams.get("year"), "2026");
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


test("Statbotics malformed cache entries are discarded before a successful fetch", async () => {
  const { client, redis } = await createClient();
  const cacheKey = "cache:statbotics:v3::match:2026ctabc_qm88";
  await redis.set(cacheKey, JSON.stringify({ data: { wrong: true }, fetchedAt: "not-a-timestamp" }));
  let requests = 0;

  await withGlobals({
    baseUrl: "https://statbotics.test",
    fetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({ key: "2026ctabc_qm88" }), {
        status: 200,
        headers: { "Cache-Control": "max-age=60" },
      });
    },
  }, async () => {
    assert.deepEqual(await client.getMatch("2026ctabc_qm88"), { key: "2026ctabc_qm88" });
  });

  assert.equal(requests, 1);
  assert.equal(await redis.get(cacheKey) !== null, true);
});

test("Statbotics 304 responses retain the cached representation and renew ETag freshness", async () => {
  const { client, redis } = await createClient();
  const cacheKey = "cache:statbotics:v3::match:2026ctabc_qm89";
  const data = { key: "2026ctabc_qm89", pred: { red_score: 101 } };
  await redis.set(cacheKey, JSON.stringify({
    data,
    etag: '"before"',
    fetchedAt: Date.now() - 1_000_000,
    lastRefreshAt: Date.now() - 1_000_000,
    expiresAt: Date.now() - 1,
  }));
  let headers;

  await withGlobals({
    baseUrl: "https://statbotics.test",
    fetch: async (_url, options) => {
      headers = options.headers;
      return new Response(null, {
        status: 304,
        headers: { "Cache-Control": "max-age=30", ETag: '"after"' },
      });
    },
  }, async () => {
    assert.deepEqual(await client.getMatch("2026ctabc_qm89"), data);
  });

  assert.equal(headers["If-None-Match"], '"before"');
  const renewed = JSON.parse(await redis.get(cacheKey));
  assert.deepEqual(renewed.data, data);
  assert.equal(renewed.etag, '"after"');
  assert.ok(renewed.expiresAt - renewed.fetchedAt >= 10 * 60 * 1000);
});

test("Statbotics lock contention serves an existing stale value without starting another request", async () => {
  const { client, redis } = await createClient();
  const cacheKey = "cache:statbotics:v3::match:2026ctabc_q90";
  const lockKey = "lock:statbotics:v3::match:2026ctabc_q90";
  const stale = { key: "2026ctabc_q90" };
  await redis.set(cacheKey, JSON.stringify({
    data: stale,
    etag: null,
    fetchedAt: Date.now() - 1_000_000,
    lastRefreshAt: Date.now() - 1_000_000,
    expiresAt: Date.now() - 1,
  }));
  await redis.set(lockKey, "another-worker", "EX", 20, "NX");
  let requests = 0;

  await withGlobals({
    baseUrl: "https://statbotics.test",
    fetch: async () => {
      requests += 1;
      throw new Error("must not fetch while another worker owns the lock");
    },
  }, async () => {
    assert.deepEqual(await client.getMatch("2026ctabc_q90"), stale);
  });

  assert.equal(requests, 0);
  assert.equal(await redis.get(lockKey), "another-worker");
});

test("concurrent Statbotics callers share one in-flight upstream request", async () => {
  const { client, redis } = await createClient();
  let requests = 0;
  let resolveResponse;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const pendingResponse = new Promise((resolve) => { resolveResponse = resolve; });

  await withGlobals({
    baseUrl: "https://statbotics.test",
    fetch: async () => {
      requests += 1;
      markStarted();
      return pendingResponse;
    },
  }, async () => {
    const first = client.getMatch("2026ctabc_qm-concurrent");
    await started;
    const second = client.getMatch("2026ctabc_qm-concurrent");
    resolveResponse(new Response(JSON.stringify({ key: "2026ctabc_qm-concurrent" }), {
      status: 200,
      headers: { "Cache-Control": "max-age=60" },
    }));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(firstResult, { key: "2026ctabc_qm-concurrent" });
    assert.deepEqual(secondResult, firstResult);
  });

  assert.equal(requests, 1);
  assert.equal(await redis.get("lock:statbotics:v3::match:2026ctabc_qm-concurrent"), null);
});

test("Statbotics releases its request lock after an upstream failure", async () => {
  const { client, redis } = await createClient();
  const lockKey = "lock:statbotics:v3::match:2026ctabc_qm-lock-failure";

  await withGlobals({
    baseUrl: "https://statbotics.test",
    fetch: async () => new Response("upstream unavailable", { status: 503 }),
  }, async () => {
    await assert.rejects(client.getMatch("2026ctabc_qm-lock-failure"), /Statbotics request failed: 503/);
  });

  assert.equal(await redis.get(lockKey), null);
});

test("Statbotics collection cache keys remain isolated by query filters", async () => {
  const { client, redis } = await createClient();
  const requestedUrls = [];

  await withGlobals({
    baseUrl: "https://statbotics.test",
    fetch: async (url) => {
      requestedUrls.push(new URL(url));
      return new Response("[]", {
        status: 200,
        headers: { "Cache-Control": "max-age=600" },
      });
    },
  }, async () => {
    assert.deepEqual(await client.getMatches({ event: "2026ctabc" }), []);
    assert.deepEqual(await client.getMatches({ team: 3461 }), []);
  });

  assert.equal(requestedUrls.length, 2);
  assert.equal(requestedUrls[0].searchParams.get("event"), "2026ctabc");
  assert.equal(requestedUrls[1].searchParams.get("team"), "3461");
  const cacheKeys = [...redis.values.keys()].filter((key) => key.startsWith("cache:statbotics:v3:"));
  assert.equal(cacheKeys.length, 2);
  assert.notEqual(cacheKeys[0], cacheKeys[1]);
});

test("Statbotics failed later pagination pages reject instead of returning a partial collection", async () => {
  const { client } = await createClient();
  let requests = 0;
  const firstPage = Array.from({ length: 1000 }, (_, index) => ({ key: `page-one-${index}` }));

  await withGlobals({
    baseUrl: "https://statbotics.test",
    fetch: async () => {
      requests += 1;
      if (requests === 1) {
        return new Response(JSON.stringify(firstPage), {
          status: 200,
          headers: { "Cache-Control": "max-age=60" },
        });
      }
      return new Response("upstream unavailable", { status: 503 });
    },
  }, async () => {
    await assert.rejects(
      client.getMatches({ event: "2026ctabc" }),
      /Statbotics request failed: 503/,
    );
  });

  assert.equal(requests, 2);
});
