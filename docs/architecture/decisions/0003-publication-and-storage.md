# ADR 0003: Event publication protocol and persistence boundary

- **Status:** Proposed — implementation blocked pending resolution
- **Date:** 2026-11-16

## Context

The legacy realtime path sends invalidation messages through Redis Pub/Sub and a WebSocket bridge. Browser EventState instances then re-read provider-backed routes. The target moves authoritative reconciliation to backend runtimes and must publish normalized FieldView state to web and remote consumers.

The publication protocol and persistence choices affect ordering, reconnect behavior, recovery, storage cost, and client complexity. They should be decided together with EventRuntime ownership, not copied from the old transport.

## Publication questions

Decide whether clients receive:
- full versioned snapshots only;
- snapshots plus versioned change events;
- or a snapshot on subscribe/reconnect followed by ordered changes.

Any selected protocol must define:
- a monotonically increasing event revision/version;
- snapshot identity and schema version;
- how clients detect gaps and request a fresh snapshot;
- replay/reconnect behavior and retention window;
- subscription authorization and per-client lifecycle;
- backpressure and slow-consumer behavior;
- whether remote displays consume the same event contract or a session-specific projection.

Do not make clients treat provider webhooks as authoritative state payloads. Provider events are inputs to reconciliation; publication exposes committed FieldView state.

## Persistence questions

Evaluate state by lifecycle rather than copying Redis key-for-key:
- Durable Object SQLite is a candidate for authoritative event state, version metadata, and bounded reconciliation/job records.
- In-memory state may be used as a cache but must be reconstructable after object restart.
- Provider response caches may remain separate from canonical domain state.
- Completed event data may be compacted/retained according to explicit product requirements.
- Analytics jobs require resumable progress and a clear policy for recomputable versus durable outputs.

No storage backend or retention duration is accepted by this ADR yet.

## Constraints

- One authoritative writer per resource.
- Failed/partial provider acquisition must not erase valid committed data.
- Explicit clears must be distinguishable from omitted fields and request failures.
- Stale work must not publish over a newer revision.
- Runtime restart and reconnect must restore a consistent published view.
- Event-timezone metadata must remain available wherever event timestamps are presented.

## Acceptance criteria before implementation

- A written snapshot/change protocol with revision and replay semantics.
- A resource-by-resource persistence/retention table.
- A concurrency model for refreshes and publication.
- Tests for duplicate/out-of-order inputs, stale work, partial failures, restart, and reconnect.
