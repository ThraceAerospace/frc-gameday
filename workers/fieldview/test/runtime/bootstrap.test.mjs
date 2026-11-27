import assert from "node:assert/strict";
import test from "node:test";
import { createEndpointState } from "../../src/runtime/endpoint-state.ts";
import { validateRuntimeBootstrapBundle } from "../../src/runtime/bootstrap.ts";

function bundle(overrides = {}) {
  const endpoint = "/api/v3/event/2027test";
  const resource = {
    ...createEndpointState(endpoint),
    status: "available",
    data: { key: "2027test" },
    providerData: { key: "2027test" },
    etag: '"v1"',
    lastFetchedAt: 1_800_000_000_000,
    expiresAt: 1_800_000_060_000,
    revision: 1,
    validatorRevision: 1,
    lastAttemptAt: 1_800_000_000_000,
  };
  return {
    version: 1,
    bootstrap_id: "season:run-1:event:2027:2027test",
    kind: "event",
    key: "2027test",
    year: 2027,
    acquired_at: 1_800_000_000_001,
    resources: [resource],
    ...overrides,
  };
}

test("runtime bootstrap contract accepts a well-formed entity-season bundle", () => {
  assert.equal(validateRuntimeBootstrapBundle(bundle(), {
    kind: "event", key: "2027test", year: 2027,
  }), true);
});

test("runtime bootstrap contract rejects a bundle for another entity or season", () => {
  const value = bundle();
  assert.equal(validateRuntimeBootstrapBundle(value, {
    kind: "event", key: "2027other", year: 2027,
  }), false);
  assert.equal(validateRuntimeBootstrapBundle(value, {
    kind: "event", key: "2027test", year: 2026,
  }), false);
  assert.equal(validateRuntimeBootstrapBundle(value, {
    kind: "team", key: "2027test", year: 2027,
  }), false);
});

test("runtime bootstrap contract rejects duplicate or malformed resource endpoints", () => {
  const value = bundle();
  value.resources.push({ ...value.resources[0] });
  assert.equal(validateRuntimeBootstrapBundle(value, {
    kind: "event", key: "2027test", year: 2027,
  }), false);

  const invalid = bundle();
  invalid.resources[0].endpoint = "//untrusted.example/resource";
  assert.equal(validateRuntimeBootstrapBundle(invalid, {
    kind: "event", key: "2027test", year: 2027,
  }), false);
});

test("runtime bootstrap contract rejects unsupported versions and oversized bundles", () => {
  assert.equal(validateRuntimeBootstrapBundle(bundle({ version: 2 }), {
    kind: "event", key: "2027test", year: 2027,
  }), false);
  assert.equal(validateRuntimeBootstrapBundle(bundle({ resources: [] }), {
    kind: "event", key: "2027test", year: 2027,
  }), false);
  assert.equal(validateRuntimeBootstrapBundle(bundle({
    resources: Array.from({ length: 33 }, (_, index) => ({
      ...createEndpointState("/resource/" + index),
    })),
  }), { kind: "event", key: "2027test", year: 2027 }), false);
});
