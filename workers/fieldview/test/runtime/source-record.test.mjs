import assert from "node:assert/strict";
import test from "node:test";
import { createProviderSourceVersion } from "../../src/runtime/source-record.ts";
import { createEndpointState } from "../../src/runtime/endpoint-state.ts";

test("stores an accepted 200 payload unchanged as a provider source version", () => {
  const previous = createEndpointState("/event/2026test/matches");
  const next = { ...previous, data: [{ key: "qm1" }], etag: '"v1"', validatorRevision: 1 };
  const payload = [{ key: "qm1", score_breakdown: { red: { totalPoints: 100 } } }];
  const version = createProviderSourceVersion(previous, next, {
    status: "modified", data: payload, etag: '"v1"', expiresAt: 500,
  }, 250);
  assert.deepEqual(version, {
    endpoint: "/event/2026test/matches",
    validatorRevision: 1,
    retrievedAt: 250,
    etag: '"v1"',
    data: payload,
  });
  assert.equal(version.data, payload);
});

test("does not create a source version for a superseded poll response", () => {
  const previous = { ...createEndpointState("/event/2026test"), validatorRevision: 2 };
  const next = { ...previous, validatorRevision: 2 };
  const version = createProviderSourceVersion(previous, next, {
    status: "modified", data: { name: "stale" }, etag: '"old"', expiresAt: null,
  }, 250);
  assert.equal(version, null);
});

test("304 and failed requests do not create provider source versions", () => {
  const previous = createEndpointState("/event/2026test");
  assert.equal(createProviderSourceVersion(previous, previous,
    { status: "not-modified", expiresAt: null }, 250), null);
  assert.equal(createProviderSourceVersion(previous, previous, { status: "failed" }, 250), null);
});
