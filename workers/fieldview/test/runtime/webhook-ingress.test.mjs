import assert from "node:assert/strict";
import test from "node:test";
import worker from "../../src/runtime/index.ts";


async function invokeWebhook(request, env) {
  const background = [];
  const response = await worker.fetch(request, env, { waitUntil: (promise) => background.push(promise) });
  await Promise.all(background);
  return response;
}

async function sign(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, body);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function environment(onForward) {
  const records = new Map();
  return {
    records,
    TBA_API_KEY: "api-key",
    TBA_WEBHOOK_SECRET: "webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    DISCOVERY_STORAGE: {
      async get(key) { return records.get(key); },
      async put(key, value) { records.set(key, String(value)); },
      async list({ prefix = "", startAfter = "", limit = 1000 } = {}) {
        return new Map([...records.entries()]
          .filter(([key]) => key.startsWith(prefix) && key > startAfter)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit));
      },
      async delete(key) { return records.delete(key); },
    },
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
  const response = await invokeWebhook(new Request("https://runtime.test/webhooks/tba", {
    method: "POST",
    headers: { "X-TBA-HMAC": signature, "Content-Type": "application/json" },
    body: raw,
  }), env);
  assert.equal(response.status, 200);
  assert.equal(forwarded.headers.get("X-FieldView-Event-Key"), "2026test");
  assert.equal(forwarded.headers.get("Authorization"), "Bearer runtime-token");
  assert.equal(await forwarded.text(), new TextDecoder().decode(raw));
});

test("TBA webhook ingress resolves event identity from nested event and match payloads", async () => {
  for (const message_data of [
    { event: { key: "2026test" } },
    { match: { event_key: "2026test", key: "2026test_qm1" } },
  ]) {
    const raw = new TextEncoder().encode(JSON.stringify({
      message_type: "match_score",
      message_data,
    })).buffer;
    const signature = await sign("webhook-secret", raw);
    let forwarded = null;
    const env = environment(() => async (request) => {
      forwarded = request;
      return new Response("accepted", { status: 200 });
    });
    const response = await invokeWebhook(new Request("https://runtime.test/webhooks/tba", {
      method: "POST",
      headers: { "X-TBA-HMAC": signature, "Content-Type": "application/json" },
      body: raw,
    }), env);
    assert.equal(response.status, 200);
    assert.equal(forwarded.headers.get("X-FieldView-Event-Key"), "2026test");
  }
});

test("invalid TBA signatures are rejected before Durable Object routing", async () => {
  let called = false;
  const env = environment(() => async () => {
    called = true;
    return new Response("unexpected");
  });
  const response = await invokeWebhook(new Request("https://runtime.test/webhooks/tba", {
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
    const response = await invokeWebhook(new Request("https://runtime.test/webhooks/tba", {
      method: "POST", headers: { "X-TBA-HMAC": signature }, body: raw,
    }), env);
    assert.equal(response.status, 200);
  }
  assert.equal(called, false);
});

test("match_score webhook dispatches to EventRuntime and starts analytics Workflow for unique teams", async () => {
  const raw = new TextEncoder().encode(JSON.stringify({
    message_type: "match_score",
    message_data: {
      event_key: "2026test",
      match: {
        key: "2026test_qm1",
        event_key: "2026test",
        alliances: {
          red: { teams: ["frc1", "frc2", "frc3"] },
          blue: { teams: ["frc3", "frc4", "frc5"] },
        },
      },
    },
  })).buffer;
  const signature = await sign("webhook-secret", raw);
  const eventTargets = [], workflows = [];
  const env = environment((id) => async (request) => {
    eventTargets.push({ id, request });
    return new Response("accepted", { status: 200 });
  });
  env.EVENT_ANALYTICS_WORKFLOW = {
    get: async () => { throw new Error("workflow does not exist yet"); },
    create: async (workflow) => { workflows.push(workflow); },
  };
  const response = await invokeWebhook(new Request("https://runtime.test/webhooks/tba", {
    method: "POST", headers: { "X-TBA-HMAC": signature }, body: raw,
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(eventTargets.map((item) => item.id), ["2026test"]);
  assert.equal(eventTargets[0].request.headers.get("X-FieldView-Webhook-Id")?.length, 64);
  assert.equal(await eventTargets[0].request.text(), new TextDecoder().decode(raw));
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0].params.event_key, "2026test");
  assert.deepEqual(workflows[0].params.affected_team_keys, [
    "frc1", "frc2", "frc3", "frc4", "frc5",
  ]);
});

test("event-scoped TBA notifications route only to EventRuntime", async () => {
  const payloads = [
    { message_type: "schedule_updated", message_data: { event_key: "2026test" } },
    { message_type: "starting_comp_level", message_data: { event_key: "2026test", comp_level: "qf" } },
    { message_type: "alliance_selection", message_data: { event_key: "2026test", event: { key: "2026test" } } },
    { message_type: "awards_posted", message_data: { event_key: "2026test", awards: [{ recipient_list: [{ team_number: 3461 }] }] } },
  ];
  for (const payload of payloads) {
    const raw = new TextEncoder().encode(JSON.stringify(payload)).buffer;
    const signature = await sign("webhook-secret", raw);
    const eventTargets = [];
    const env = environment((id) => async () => {
      eventTargets.push(id);
      return new Response("accepted", { status: 200 });
    });
    const response = await invokeWebhook(new Request("https://runtime.test/webhooks/tba", {
      method: "POST", headers: { "X-TBA-HMAC": signature }, body: raw,
    }), env);
    assert.equal(response.status, 200, payload.message_type);
    assert.deepEqual(eventTargets, ["2026test"], payload.message_type);
  }
});

test("TBA webhook preserves its 200 acknowledgement when analytics Workflow dispatch fails", async () => {
  const raw = new TextEncoder().encode(JSON.stringify({
    message_type: "match_score",
    message_data: {
      event_key: "2026test",
      match: { alliances: { red: { teams: ["frc1"] }, blue: { teams: ["frc2"] } } },
    },
  })).buffer;
  const signature = await sign("webhook-secret", raw);
  const eventCalls = [];
  const env = environment((id) => async () => {
    eventCalls.push(id);
    return new Response("accepted", { status: 200 });
  });
  env.EVENT_ANALYTICS_WORKFLOW = {
    get: async () => { throw new Error("workflow does not exist yet"); },
    create: async () => { throw new Error("Workflow service unavailable"); },
  };
  const response = await invokeWebhook(new Request("https://runtime.test/webhooks/tba", {
    method: "POST", headers: { "X-TBA-HMAC": signature }, body: raw,
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(eventCalls, ["2026test"]);
});


test("TBA acknowledges an authenticated webhook and registers EventRuntime processing with waitUntil", async () => {
  const raw = new TextEncoder().encode(JSON.stringify({
    message_type: "match_score",
    message_data: { event_key: "2026test", match: { alliances: { red: { teams: ["frc1"] }, blue: { teams: [] } } } },
  })).buffer;
  const signature = await sign("webhook-secret", raw);
  let dispatched = false;
  let background;
  const env = environment(() => async () => {
    dispatched = true;
    return new Response("accepted", { status: 200 });
  });
  const response = await worker.fetch(new Request("https://runtime.test/webhooks/tba", {
    method: "POST", headers: { "X-TBA-HMAC": signature }, body: raw,
  }), env, { waitUntil: (promise) => { background = promise; } });
  assert.equal(response.status, 200);
  assert.ok(background instanceof Promise);
  await background;
  assert.equal(dispatched, true);
});


test("TBA preserves the established missing-signature authentication response", async () => {
  const response = await worker.fetch(new Request("https://runtime.test/webhooks/tba", {
    method: "POST", body: "{}",
  }), environment(() => async () => new Response("unexpected")), { waitUntil: () => {
    assert.fail("Unauthenticated webhook must not schedule background work");
  } });
  assert.equal(response.status, 418);
});