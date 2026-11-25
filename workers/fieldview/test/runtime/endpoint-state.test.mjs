import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPollResponse, applyWebhookUpdate, createEndpointState, createPollRequestSnapshot,
} from "../../src/runtime/endpoint-state.ts";

const replace = (_current, incoming) => incoming;

test("captures endpoint ETag and revision for a conditional poll", () => {
  const initial = createEndpointState("/event/2026test/matches");
  const first = createPollRequestSnapshot(initial);
  const stored = applyPollResponse(initial, first,
    { status: "modified", data: ["qm1"], etag: '"v1"', expiresAt: 200 }, 100, replace);
  assert.equal(stored.etag, '"v1"');
  assert.deepEqual(createPollRequestSnapshot(stored),
    { revision: 1, validatorRevision: 1, ifNoneMatch: '"v1"' });
});

test("304 is a strict no-op for endpoint state", () => {
  const initial = { ...createEndpointState("/event/2026test/matches"),
    data: ["qm1"], providerData: ["qm1"], etag: '"v1"', lastFetchedAt: 100, expiresAt: 200, revision: 4, validatorRevision: 1 };
  const next = applyPollResponse(initial, createPollRequestSnapshot(initial),
    { status: "not-modified", expiresAt: 500 }, 300, replace);
  assert.deepEqual(next, initial);
  assert.equal(next.data, initial.data);
  assert.equal(next.providerData, initial.providerData);
  assert.equal(next.etag, '"v1"');
  assert.equal(next.lastFetchedAt, 100);
  assert.equal(next.expiresAt, 200);
  assert.equal(next.revision, 4);
  assert.equal(next.lastAttemptAt, null);
});

test("200 without ETag clears the old validator", () => {
  const initial = { ...createEndpointState("/event/2026test/matches"), data: ["old"], etag: '"old"' };
  const next = applyPollResponse(initial, createPollRequestSnapshot(initial),
    { status: "modified", data: ["new"], etag: null, expiresAt: null }, 300, replace);
  assert.deepEqual(next.data, ["new"]);
  assert.deepEqual(next.providerData, ["new"]);
  assert.equal(next.etag, null);
});

test("failed poll preserves good data, validator, freshness, and revision", () => {
  const initial = { ...createEndpointState("/event/2026test/matches"),
    data: ["good"], providerData: ["good"], etag: '"v1"', lastFetchedAt: 100, expiresAt: 200,
    revision: 3, validatorRevision: 1 };
  const next = applyPollResponse(initial, createPollRequestSnapshot(initial),
    { status: "failed" }, 300, replace);
  assert.deepEqual(next.data, ["good"]);
  assert.deepEqual(next.providerData, ["good"]);
  assert.equal(next.etag, '"v1"');
  assert.equal(next.lastFetchedAt, 100);
  assert.equal(next.expiresAt, 200);
  assert.equal(next.revision, 3);
  assert.equal(next.lastAttemptAt, 300);
  assert.equal(next.status, "stale");
});

test("poll reconciles against latest state after an intervening webhook", () => {
  const initial = { ...createEndpointState("/event/2026test/matches"),
    data: { qm1: "scheduled" }, etag: '"v1"', revision: 1, validatorRevision: 1 };
  const request = createPollRequestSnapshot(initial);
  const afterWebhook = applyWebhookUpdate(initial,
    { qm1: "played", qm2: "scheduled" }, 150, (_latest, incoming) => incoming);
  const next = applyPollResponse(afterWebhook, request, {
    status: "modified",
    data: { qm1: "scheduled", qm2: "played", qm3: "scheduled" },
    etag: '"v2"', expiresAt: 500,
  }, 200, (latest, fetched) => ({ ...fetched, qm1: latest.qm1 }));
  assert.equal(next.data.qm1, "played");
  assert.equal(next.data.qm2, "played");
  assert.equal(next.data.qm3, "scheduled");
  assert.equal(next.revision, 3);
  assert.equal(next.etag, '"v2"');
});

test("webhook update preserves upstream validator and fetch timestamps", () => {
  const initial = { ...createEndpointState("/event/2026test/matches"),
    data: ["qm1"], providerData: ["qm1"], etag: '"v1"', lastFetchedAt: 100, lastAttemptAt: 110 };
  const next = applyWebhookUpdate(initial, ["qm1", "qm2"], 250, replace);
  assert.deepEqual(next.data, ["qm1", "qm2"]);
  assert.deepEqual(next.providerData, ["qm1"]);
  assert.equal(next.etag, '"v1"');
  assert.equal(next.revision, 1);
  assert.equal(next.lastWebhookAt, 250);
  assert.equal(next.lastFetchedAt, 100);
  assert.equal(next.lastAttemptAt, 110);
});

test("endpoint state rejects non-provider-relative paths", () => {
  assert.throws(() => createEndpointState("https://example.test"), /provider-relative/);
  assert.throws(() => createEndpointState("//example.test"), /provider-relative/);
});

test("delayed 304 cannot refresh a newer validator generation", () => {
  const original = { ...createEndpointState("/event/2026test/matches"),
    data: ["v1"], etag: '"v1"', revision: 1, validatorRevision: 1,
    lastFetchedAt: 100, expiresAt: 200 };
  const oldRequest = createPollRequestSnapshot(original);
  const newer = { ...original, data: ["v2"], etag: '"v2"', revision: 2,
    validatorRevision: 2, lastFetchedAt: 250, expiresAt: 350 };
  const delayed = applyPollResponse(newer, oldRequest,
    { status: "not-modified", expiresAt: 900 }, 400, replace);
  assert.equal(delayed.etag, '"v2"');
  assert.equal(delayed.lastFetchedAt, 250);
  assert.equal(delayed.expiresAt, 350);
});

test("delayed 200 cannot roll back a validator installed by a newer poll", () => {
  const original = { ...createEndpointState("/event/2026test/matches"),
    data: ["v1"], etag: '"v1"', revision: 1, validatorRevision: 1 };
  const oldRequest = createPollRequestSnapshot(original);
  const newer = { ...original, data: ["v3"], etag: '"v3"', revision: 2,
    validatorRevision: 2, lastFetchedAt: 250, expiresAt: 350 };
  const delayed = applyPollResponse(newer, oldRequest,
    { status: "modified", data: ["v2"], etag: '"v2"', expiresAt: 300 },
    400, (_latest, fetched) => fetched);
  assert.equal(delayed.etag, '"v3"');
  assert.equal(delayed.lastFetchedAt, 250);
  assert.equal(delayed.expiresAt, 350);
  assert.deepEqual(delayed.data, ["v3"]);
});

test("distinguishes an unavailable endpoint from a failed acquisition", () => {
  const initial = createEndpointState("/event/2026test/awards");
  const unavailable = applyPollResponse(initial, createPollRequestSnapshot(initial),
    { status: "unavailable" }, 100, replace);
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.data, null);

  const failed = applyPollResponse(initial, createPollRequestSnapshot(initial),
    { status: "failed" }, 100, replace);
  assert.equal(failed.status, "failed");
  assert.equal(failed.data, null);
});

test("an unavailable response does not erase a previously usable representation", () => {
  const initial = { ...createEndpointState("/event/2026test/awards"),
    status: "available", data: [], providerData: [], lastFetchedAt: 100 };
  const next = applyPollResponse(initial, createPollRequestSnapshot(initial),
    { status: "unavailable" }, 200, replace);
  assert.equal(next.status, "stale");
  assert.deepEqual(next.data, []);
  assert.deepEqual(next.providerData, []);
  assert.equal(next.lastFetchedAt, 100);
});

test("304 without a retained HTTP representation is still a strict no-op", () => {
  const initial = createEndpointState("/event/2026test/matches");
  const next = applyPollResponse(initial, createPollRequestSnapshot(initial),
    { status: "not-modified", expiresAt: 100 }, 50, replace);
  assert.deepEqual(next, initial);
  assert.equal(next.status, "unknown");
  assert.equal(next.lastFetchedAt, null);
  assert.equal(next.providerData, null);
  assert.equal(createPollRequestSnapshot(initial).ifNoneMatch, null);
});
