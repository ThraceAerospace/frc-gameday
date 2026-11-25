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

function environment(onForward, onTeamForward) {
  return {
    TBA_API_KEY: "api-key",
    TBA_WEBHOOK_SECRET: "webhook-secret",
    RUNTIME_ADMIN_TOKEN: "runtime-token",
    EVENT_RUNTIME: {
      idFromName: (name) => name,
      get: (id) => ({ fetch: onForward(id) }),
    },
    ...(onTeamForward ? {
      TEAM_RUNTIME: {
        idFromName: (name) => name,
        get: (id) => ({ fetch: onTeamForward(id) }),
      },
    } : {}),
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

test("match_score webhook fans out once to the event and each unique participating team", async () => {
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
  const eventTargets = [], teamTargets = [];
  const env = environment((id) => async (request) => {
    eventTargets.push({ id, request });
    return new Response("accepted", { status: 200 });
  }, (id) => async (request) => {
    teamTargets.push({ id, request });
    return new Response("accepted", { status: 200 });
  });
  const response = await invokeWebhook(new Request("https://runtime.test/webhooks/tba", {
    method: "POST", headers: { "X-TBA-HMAC": signature }, body: raw,
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(eventTargets.map((item) => item.id), ["2026test"]);
  assert.deepEqual(teamTargets.map((item) => item.id).sort(), ["frc1", "frc2", "frc3", "frc4", "frc5"]);
  for (const target of [...eventTargets, ...teamTargets]) {
    assert.equal(target.request.headers.get("X-FieldView-Webhook-Id")?.length, 64);
    assert.equal(await target.request.text(), new TextDecoder().decode(raw));
  }
});

test("event-scoped TBA notifications do not guess TeamRuntime recipients", async () => {
  const payloads = [
    { message_type: "schedule_updated", message_data: { event_key: "2026test" } },
    { message_type: "starting_comp_level", message_data: { event_key: "2026test", comp_level: "qf" } },
    { message_type: "alliance_selection", message_data: { event_key: "2026test", event: { key: "2026test" } } },
    { message_type: "awards_posted", message_data: { event_key: "2026test", awards: [{ recipient_list: [{ team_number: 3461 }] }] } },
  ];
  for (const payload of payloads) {
    const raw = new TextEncoder().encode(JSON.stringify(payload)).buffer;
    const signature = await sign("webhook-secret", raw);
    const eventTargets = [], teamTargets = [];
    const env = environment((id) => async () => {
      eventTargets.push(id);
      return new Response("accepted", { status: 200 });
    }, (id) => async () => {
      teamTargets.push(id);
      return new Response("accepted", { status: 200 });
    });
    const response = await invokeWebhook(new Request("https://runtime.test/webhooks/tba", {
      method: "POST", headers: { "X-TBA-HMAC": signature }, body: raw,
    }), env);
    assert.equal(response.status, 200, payload.message_type);
    assert.deepEqual(eventTargets, ["2026test"], payload.message_type);
    assert.deepEqual(teamTargets, [], payload.message_type);
  }
});

test("TBA webhook ingress logs partial fan-out failures while preserving the 200 acknowledgement", async () => {
  const raw = new TextEncoder().encode(JSON.stringify({
    message_type: "match_score",
    message_data: {
      event_key: "2026test",
      match: { alliances: { red: { teams: ["frc1"] }, blue: { teams: ["frc2"] } } },
    },
  })).buffer;
  const signature = await sign("webhook-secret", raw);
  const calls = [];
  const env = environment((id) => async () => {
    calls.push(["event", id]);
    return new Response("accepted", { status: 200 });
  }, (id) => async () => {
    calls.push(["team", id]);
    return new Response("unavailable", { status: id === "frc2" ? 503 : 200 });
  });
  const response = await invokeWebhook(new Request("https://runtime.test/webhooks/tba", {
    method: "POST", headers: { "X-TBA-HMAC": signature }, body: raw,
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.sort((a, b) => a.join(":").localeCompare(b.join(":"))), [
    ["event", "2026test"], ["team", "frc1"], ["team", "frc2"],
  ]);
});


test("TBA acknowledges an authenticated webhook and registers runtime fan-out with waitUntil", async () => {
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
  }, () => async () => new Response("accepted", { status: 200 }));
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