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


test("TBA standalone match responses are not reconciled using collection-only rules", async () => {
  const client = new TBAClient("test-auth-key");
  const endpoint = "/match/2026ctabc_qm77";
  const completed = match({
    key: "2026ctabc_qm77",
    redScore: 91,
    blueScore: 84,
    actualTime: 1_800_000_000,
  });
  const incomplete = match({
    key: "2026ctabc_qm77",
    redScore: -1,
    blueScore: -1,
  });
  await redis.set(cacheKey(endpoint), JSON.stringify({
    data: completed,
    etag: '"old"',
    expiresAt: Date.now() - 1_000,
  }));

  await withFetch(async () => new Response(JSON.stringify(incomplete), {
    status: 200,
    headers: { "Cache-Control": "max-age=60" },
  }), async () => {
    assert.deepEqual(await client.get(endpoint), incomplete);
  });
});

test("TBA upcoming-match webhook patches only supplied fields and preserves unrelated cached matches", async () => {
  const client = new TBAClient("test-auth-key");
  const endpoint = "/event/2026ctabc/matches";
  const key = cacheKey(endpoint);
  const first = {
    ...match({ key: "2026ctabc_qm1", redScore: 80, blueScore: 70 }),
    predicted_time: 100,
    scheduled_time: 90,
  };
  const second = match({ key: "2026ctabc_qm2", redScore: -1, blueScore: -1 });
  await redis.set(key, JSON.stringify({
    data: [first, second],
    etag: '"webhook"',
    expiresAt: Date.now() + 60_000,
  }));

  await client.mutateUpcomingMatch({
    event_key: "2026ctabc",
    match_key: "2026ctabc_qm1",
    predicted_time: 150,
  });

  const updated = JSON.parse(await redis.get(key));
  assert.equal(updated.data[0].predicted_time, 150);
  assert.equal(updated.data[0].scheduled_time, 90);
  assert.deepEqual(updated.data[1], second);
  assert.equal(updated.etag, '"webhook"');
});

test("TBA tag invalidation removes only cache entries owned by the requested tag", async () => {
  const client = new TBAClient("test-auth-key");
  const eventCache = cacheKey("/event/2026ctabc/matches");
  const teamCache = cacheKey("/team/frc1");
  await redis.set(eventCache, JSON.stringify({ data: [], etag: null, expiresAt: Date.now() }));
  await redis.set(teamCache, JSON.stringify({ data: {}, etag: null, expiresAt: Date.now() }));
  redis.sets.set("tag:event:2026ctabc", new Set([eventCache]));

  await client.invalidateTag("event:2026ctabc");

  assert.equal(await redis.get(eventCache), null);
  assert.notEqual(await redis.get(teamCache), null);
  assert.deepEqual(await redis.smembers("tag:event:2026ctabc"), []);
});

test("TBA derives cache tags for event, team, team-event, and match resource families", async () => {
  const client = new TBAClient("test-auth-key");
  const endpoints = [
    "/event/2026cttagstest",
    "/event/2026cttagstest/teams",
    "/team/frc3461",
    "/team/frc3461/event/2026cttagstest",
    "/match/2026cttagstest_qm1",
  ];

  await withFetch(async (url) => new Response(JSON.stringify({ endpoint: new URL(url).pathname }), {
    status: 200,
    headers: { "Cache-Control": "max-age=60" },
  }), async () => {
    for (const endpoint of endpoints) await client.get(endpoint);
  });

  const expectedTags = {
    "tag:event:2026cttagstest": [cacheKey(endpoints[0]), cacheKey(endpoints[1]), cacheKey(endpoints[3])],
    "tag:event:2026cttagstest:teams": [cacheKey(endpoints[1])],
    "tag:team:frc3461": [cacheKey(endpoints[2]), cacheKey(endpoints[3])],
    "tag:team:frc3461:event:2026cttagstest": [cacheKey(endpoints[3])],
    "tag:match:2026cttagstest_qm1": [cacheKey(endpoints[4])],
  };

  for (const [tag, expectedMembers] of Object.entries(expectedTags)) {
    assert.deepEqual(new Set(await redis.smembers(tag)), new Set(expectedMembers), tag);
  }
});

test("TBA cache mutation failures return false and preserve the previous cached value", async () => {
  const client = new TBAClient("test-auth-key");
  const endpoint = "/event/2026ctmutation";
  const key = cacheKey(endpoint);
  const original = { data: { value: 1 }, etag: '"original"', expiresAt: Date.now() + 60_000 };
  await redis.set(key, JSON.stringify(original));

  assert.equal(await client.mutateCached(endpoint, () => {
    throw new Error("mutator failed");
  }), false);
  assert.deepEqual(JSON.parse(await redis.get(key)), original);

  const originalSet = redis.set;
  redis.set = async (candidate, value) => {
    if (candidate === key) throw new Error("Redis write failed");
    return originalSet.call(redis, candidate, value);
  };
  try {
    assert.equal(await client.mutateCached(endpoint, (data) => ({ ...data, value: 2 })), false);
  } finally {
    redis.set = originalSet;
  }

  assert.deepEqual(JSON.parse(await redis.get(key)), original);
});

test("TBA tag invalidation propagates Redis pipeline failures without pretending success", async () => {
  const client = new TBAClient("test-auth-key");
  const endpoint = "/event/2026ctinvalidate";
  const key = cacheKey(endpoint);
  await redis.set(key, JSON.stringify({
    data: { key: "2026ctinvalidate" },
    etag: null,
    expiresAt: Date.now() + 60_000,
  }));
  redis.sets.set("tag:event:2026ctinvalidate", new Set([key]));

  const originalPipeline = redis.pipeline.bind(redis);
  redis.pipeline = () => {
    const pipeline = originalPipeline();
    pipeline.exec = async () => { throw new Error("Redis pipeline unavailable"); };
    return pipeline;
  };
  try {
    await assert.rejects(
      client.invalidateTag("event:2026ctinvalidate"),
      /Redis pipeline unavailable/,
    );
  } finally {
    redis.pipeline = originalPipeline;
  }

  assert.notEqual(await redis.get(key), null);
  assert.deepEqual(await redis.smembers("tag:event:2026ctinvalidate"), [key]);
});

test("TBA malformed cache entries are discarded before fetching a valid response", async () => {
  const client = new TBAClient("test-auth-key");
  const endpoint = "/event/2026ctmalformed/teams";
  await redis.set(cacheKey(endpoint), JSON.stringify({ unexpected: true }));
  let requests = 0;

  await withFetch(async () => {
    requests += 1;
    return new Response(JSON.stringify([{ key: "frc1" }]), {
      status: 200,
      headers: { "Cache-Control": "max-age=30" },
    });
  }, async () => {
    assert.deepEqual(await client.get(endpoint), [{ key: "frc1" }]);
  });

  assert.equal(requests, 1);
  assert.deepEqual(JSON.parse(await redis.get(cacheKey(endpoint))).data, [{ key: "frc1" }]);
});


test("TBA accepts quoted and zero max-age values without substituting a local TTL", async () => {
  const client = new TBAClient("test-auth-key");
  const quotedEndpoint = "/event/2026ctquote/teams";
  const zeroEndpoint = "/event/2026ctzero/robots";
  await withFetch(async () => new Response(JSON.stringify([]), {
    status: 200,
    headers: { "Cache-Control": 'public, max-age="45"' },
  }), async () => {
    await client.get(quotedEndpoint);
  });
  const quoted = JSON.parse(await redis.get(cacheKey(quotedEndpoint)));
  assert.ok(quoted.expiresAt - Date.now() > 40_000);

  await withFetch(async () => new Response(JSON.stringify([]), {
    status: 200,
    headers: { "Cache-Control": "max-age=0" },
  }), async () => {
    await client.get(zeroEndpoint);
  });
  const zero = JSON.parse(await redis.get(cacheKey(zeroEndpoint)));
  assert.ok(zero.expiresAt - Date.now() <= 100);
});

test("TBA rejects malformed max-age values rather than inventing cache freshness", async () => {
  const client = new TBAClient("test-auth-key");
  for (const [index, cacheControl] of [
    "public, max-age=invalid",
    "public, max-age=-1",
    'public, max-age="invalid"',
  ].entries()) {
    const endpoint = `/event/2026ctabc/malformed-${index}`;
    await assert.rejects(
      withFetch(async () => new Response(JSON.stringify({ key: "2026ctabc" }), {
        status: 200,
        headers: { "Cache-Control": cacheControl },
      }), () => client.get(endpoint)),
      /did not provide Cache-Control max-age/,
    );
    assert.equal(await redis.get(cacheKey(endpoint)), null);
  }
});

test("TBA does not overwrite a webhook-updated cache entry with an in-flight stale response", async () => {
  const client = new TBAClient("test-auth-key");
  const endpoint = "/event/2026ctabc/matches";
  const key = cacheKey(endpoint);
  const staleResponse = [{ key: "2026ctabc_qm1", predicted_time: 100 }];
  const webhookValue = [{ key: "2026ctabc_qm1", predicted_time: 250 }];
  let requests = 0;

  await withFetch(async () => {
    requests += 1;
    await redis.set(key, JSON.stringify({
      data: webhookValue,
      etag: '"webhook"',
      expiresAt: Date.now() + 60_000,
    }));
    return new Response(JSON.stringify(staleResponse), {
      status: 200,
      headers: { "Cache-Control": "max-age=60" },
    });
  }, async () => {
    assert.deepEqual(await client.get(endpoint), webhookValue);
  });

  assert.equal(requests, 1);
  assert.deepEqual(JSON.parse(await redis.get(key)).data, webhookValue);
});
