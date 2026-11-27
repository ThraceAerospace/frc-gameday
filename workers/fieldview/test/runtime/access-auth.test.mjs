import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { isCloudflareAccessAdmin } from "../../src/runtime/access-auth.ts";

const issuer = "https://fieldview.cloudflareaccess.com";
const audience = "fieldview-runtime-admin-audience";
const now = 1_800_000_000;
const pair = await webcrypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = { ...(await webcrypto.subtle.exportKey("jwk", pair.publicKey)), kid: "fieldview-test-key", alg: "RS256", use: "sig" };

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function tokenFor(overrides = {}, signingKey = pair.privateKey, headerOverrides = {}) {
  const header = encode({ alg: "RS256", typ: "JWT", kid: "fieldview-test-key", ...headerOverrides });
  const payload = encode({
    iss: issuer,
    aud: [audience],
    sub: "test-user",
    email: "admin@example.com",
    iat: now - 30,
    exp: now + 300,
    ...overrides,
  });
  const input = header + "." + payload;
  const signature = await webcrypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    signingKey,
    new TextEncoder().encode(input),
  );
  return input + "." + Buffer.from(signature).toString("base64url");
}

function environment(overrides = {}) {
  return {
    CF_ACCESS_TEAM_DOMAIN: issuer,
    CF_ACCESS_AUD: audience,
    RUNTIME_ADMIN_EMAILS: "admin@example.com",
    fetcher: async (input) => {
      assert.equal(String(input), issuer + "/cdn-cgi/access/certs");
      return Response.json({ keys: [publicJwk] }, { headers: { "Cache-Control": "public, max-age=300" } });
    },
    ...overrides,
  };
}

async function requestFor(token) {
  return new Request("https://runtime.example/internal/admin/overview", {
    headers: { "Cf-Access-Jwt-Assertion": token },
  });
}

test("accepts a correctly signed, audience-bound Access JWT for an allowlisted administrator", async () => {
  const token = await tokenFor();
  assert.equal(await isCloudflareAccessAdmin(await requestFor(token), environment(), now), true);
});

test("rejects a bearer token and unsigned Access identity headers", async () => {
  const bearer = new Request("https://runtime.example/internal/admin/overview", {
    headers: { Authorization: "Bearer old-admin-token", "Cf-Access-Authenticated-User-Email": "admin@example.com" },
  });
  assert.equal(await isCloudflareAccessAdmin(bearer, environment(), now), false);
});

test("rejects missing configuration and missing administrator allowlist", async () => {
  const token = await tokenFor();
  assert.equal(await isCloudflareAccessAdmin(await requestFor(token), {}, now), false);
  assert.equal(await isCloudflareAccessAdmin(await requestFor(token), environment({ RUNTIME_ADMIN_EMAILS: "" }), now), false);
});

test("rejects incorrect issuer, audience, expired, and not-yet-valid claims", async () => {
  const cases = [
    { iss: "https://attacker.cloudflareaccess.com" },
    { aud: ["another-application"] },
    { exp: now },
    { nbf: now + 1 },
    { iat: now + 61 },
  ];
  for (const claims of cases) {
    assert.equal(await isCloudflareAccessAdmin(await requestFor(await tokenFor(claims)), environment(), now), false);
  }
});

test("rejects identities outside the explicit administrator allowlist", async () => {
  const token = await tokenFor({ email: "other@example.com" });
  assert.equal(await isCloudflareAccessAdmin(await requestFor(token), environment(), now), false);
});

test("rejects non-RS256 algorithms, malformed tokens, and invalid signatures", async () => {
  const malformed = await requestFor("not.a.jwt");
  assert.equal(await isCloudflareAccessAdmin(malformed, environment(), now), false);

  const wrongAlgorithm = await tokenFor({}, pair.privateKey, { alg: "HS256" });
  assert.equal(await isCloudflareAccessAdmin(await requestFor(wrongAlgorithm), environment(), now), false);

  const otherPair = await webcrypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const invalidSignature = await tokenFor({}, otherPair.privateKey);
  assert.equal(await isCloudflareAccessAdmin(await requestFor(invalidSignature), environment(), now), false);
});


test("allows explicit local admin access only on plain-HTTP loopback hosts", async () => {
  const localEnvironment = environment({ LOCAL_ADMIN_AUTH: "true" });
  for (const url of [
    "http://localhost:8787/internal/admin/overview",
    "http://127.0.0.1:8787/internal/admin/overview",
    "http://[::1]:8787/internal/admin/overview",
  ]) {
    assert.equal(await isCloudflareAccessAdmin(new Request(url), localEnvironment, now), true, url);
  }
});

test("local admin bypass requires the explicit flag and rejects non-loopback or HTTPS hosts", async () => {
  const enabled = environment({ LOCAL_ADMIN_AUTH: "true" });
  for (const url of [
    "https://localhost/internal/admin/overview",
    "http://localhost.example.com/internal/admin/overview",
    "http://192.168.1.20:8787/internal/admin/overview",
    "https://runtime.example/internal/admin/overview",
  ]) {
    assert.equal(await isCloudflareAccessAdmin(new Request(url), enabled, now), false, url);
  }
  assert.equal(
    await isCloudflareAccessAdmin(
      new Request("http://localhost:8787/internal/admin/overview"),
      environment({ LOCAL_ADMIN_AUTH: "false" }),
      now,
    ),
    false,
  );
  assert.equal(
    await isCloudflareAccessAdmin(
      new Request("http://localhost:8787/internal/admin/overview"),
      environment(),
      now,
    ),
    false,
  );
});
