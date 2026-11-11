import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTypeScriptModuleWithMocks } from "../helpers/load-typescript-with-mocks.mjs";

class FakeRedis {
  values = new Map();
  sets = new Map();

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async set(key, value) {
    this.values.set(key, value);
    return "OK";
  }

  async del(key) {
    this.values.delete(key);
    this.sets.delete(key);
    return 1;
  }

  async smembers(key) {
    return [...(this.sets.get(key) ?? [])];
  }

  pipeline() {
    const operations = [];
    const pipeline = {
      sadd: (key, member) => {
        operations.push(["sadd", key, member]);
        return pipeline;
      },
      del: (key) => {
        operations.push(["del", key]);
        return pipeline;
      },
      exec: async () => {
        for (const [operation, key, value] of operations) {
          if (operation === "sadd") {
            const members = this.sets.get(key) ?? new Set();
            members.add(value);
            this.sets.set(key, members);
          } else {
            this.values.delete(key);
            this.sets.delete(key);
          }
        }
        return [];
      },
    };
    return pipeline;
  }
}

const redis = new FakeRedis();
const { TBAClient, cacheKey } = await loadTypeScriptModuleWithMocks(
  "src/lib/tba/client.ts",
  { "@/lib/cache/redis": { redis } },
);

function withFetch(implementation, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = implementation;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

function match({
  key,
  redScore,
  blueScore,
  actualTime = null,
}) {
  return {
    key,
    actual_time: actualTime,
    post_result_time: null,
    score_breakdown: null,
    alliances: {
      red: { score: redScore, team_keys: ["frc1", "frc2", "frc3"] },
      blue: { score: blueScore, team_keys: ["frc4", "frc5", "frc6"] },
    },
  };
}

test("TBA cache keys are namespaced and normalize endpoint separators", () => {
  assert.equal(cacheKey("/event/2026ctabc/matches"), "cache:event:2026ctabc:matches");
});

test("TBA client fetches on a cache miss and stores provider freshness and tags", async () => {
  const client = new TBAClient("test-auth-key");
  const endpoint = "/event/2026ctabc/matches";
  const data = [{ key: "2026ctabc_qm1" }];
  let request;

  await withFetch(async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=120",
        ETag: '"tba-v1"',
      },
    });
  }, async () => {
    const result = await client.get(endpoint);
    assert.deepEqual(result, data);
  });

  assert.equal(request.url, "https://www.thebluealliance.com/api/v3" + endpoint);
  assert.equal(request.options.headers["X-TBA-Auth-Key"], "test-auth-key");

  const cached = JSON.parse(await redis.get(cacheKey(endpoint)));
  assert.deepEqual(cached.data, data);
  assert.equal(cached.etag, '"tba-v1"');
  assert.ok(cached.expiresAt > Date.now());
  assert.ok((await redis.smembers("tag:event:2026ctabc")).includes(cacheKey(endpoint)));
  assert.ok((await redis.smembers("tag:event:2026ctabc:matches")).includes(cacheKey(endpoint)));
});

test("TBA 304 responses renew cached expiry without replacing cached data", async () => {
  const client = new TBAClient("test-auth-key");
  const endpoint = "/event/2026ctabc/matches";
  const key = cacheKey(endpoint);
  const originalData = [{ key: "2026ctabc_qm1" }];
  await redis.set(key, JSON.stringify({
    data: originalData,
    etag: '"tba-v1"',
    expiresAt: Date.now() - 1_000,
  }));
  let requestHeaders;

  await withFetch(async (_url, options) => {
    requestHeaders = options.headers;
    return new Response(null, {
      status: 304,
      headers: { "Cache-Control": "max-age=45" },
    });
  }, async () => {
    assert.deepEqual(await client.get(endpoint), originalData);
  });

  assert.equal(requestHeaders["If-None-Match"], '"tba-v1"');
  const renewed = JSON.parse(await redis.get(key));
  assert.deepEqual(renewed.data, originalData);
  assert.ok(renewed.expiresAt > Date.now());
});

test("TBA collection reconciliation preserves a cached completed match over an incomplete response", async () => {
  const client = new TBAClient("test-auth-key");
  const endpoint = "/event/2026ctabc/matches";
  const key = cacheKey(endpoint);
  const completed = match({
    key: "2026ctabc_qm1",
    redScore: 91,
    blueScore: 84,
    actualTime: 1_800_000_000,
  });
  const incomplete = match({
    key: "2026ctabc_qm1",
    redScore: -1,
    blueScore: -1,
  });
  await redis.set(key, JSON.stringify({
    data: [completed],
    etag: '"old"',
    expiresAt: Date.now() - 1_000,
  }));

  await withFetch(async () => new Response(JSON.stringify([incomplete]), {
    status: 200,
    headers: { "Cache-Control": "max-age=60" },
  }), async () => {
    const result = await client.get(endpoint);
    assert.deepEqual(result, [completed]);
  });

  assert.deepEqual(JSON.parse(await redis.get(key)).data, [completed]);
});

test("TBA rejects successful responses without provider max-age instead of inventing freshness", async () => {
  const client = new TBAClient("test-auth-key");
  const endpoint = "/event/2026ctabc";
  await assert.rejects(
    withFetch(async () => new Response(JSON.stringify({ key: "2026ctabc" }), {
      status: 200,
    }), () => client.get(endpoint)),
    /did not provide Cache-Control max-age/,
  );
  assert.equal(await redis.get(cacheKey(endpoint)), null);
});
