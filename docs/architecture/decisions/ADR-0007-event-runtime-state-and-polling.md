# ADR-0007: EventRuntime state ownership and conditional polling

> **Status: Partially superseded.** The event-scoped ownership and provider validator/reconciliation principles remain valid. Its Durable Object alarm scheduling, EventScheduler/TaskScheduler ownership, persisted normalized-state publication, and revision-only WebSocket rules are superseded by the later storage/polling decisions and ADR-0020. This summary replaces the obsolete implementation instructions formerly included below.

- **Original status:** Accepted
- **Original date:** 2026-11-17
- **Current authority:** [Storage and polling ownership](2026-11-24-storage-and-polling-ownership.md) and [ADR-0020](ADR-0020-ephemeral-state-projections-and-snapshot-first-stream.md)

## Principles retained

- One EventRuntime Durable Object owns each event's provider endpoint records and event-scoped canonical data.
- Provider clients are stateless transport adapters. They own authentication, endpoint paths, provider schemas, and HTTP semantics; they do not own durable validators or FieldView canonical state.
- ETags validate individual provider HTTP endpoint representations. Persist validators with the endpoint records they describe.
- A successful provider response is reconciled against the latest durable endpoint state. Do not hold a storage transaction or lock over network I/O.
- Webhook changes and provider polls must be reconciled without losing useful concurrent updates.
- Failed or malformed acquisition must preserve last-good data. A failure for one endpoint must not erase unrelated valid records.
- Missing, explicit null/clear, zero, unavailable, stale, and failed are distinct states.
- EventRuntime remains the sole owner of event-scoped state; do not create a Durable Object per endpoint, match, or interface.

## Superseded mechanisms

The original decision assigned recurring polling and task scheduling to EventRuntime alarms and a global EventScheduler. That scheduling model is no longer used. The consolidated Worker's polling coordinator selects due runtime identities and dispatches bounded refresh commands; EventRuntime performs its own ongoing provider requests after receiving a command. Durable Object alarm handlers and alarm polling are not part of the target architecture.

The original decision also described a persisted normalized EventState publication and revision-only stream messages followed by client HTTP snapshot recovery. ADR-0020 replaces this with read-time ephemeral EventState projections and data-bearing stream notifications. The browser reads the HTTP snapshot first; subsequent notifications carry the changed data and never cause an HTTP refetch.

A one-time provider acquisition by the initialization Workflow is permitted only when an EventRuntime is first registered/created, to reliably hydrate its durable provider endpoint records. This is the narrow exception defined by ADR-0020; it is not recurring provider acquisition.

## Current contract

See [ADR-0020](ADR-0020-ephemeral-state-projections-and-snapshot-first-stream.md) for the normative provider storage, first-registration bootstrap, read, and realtime behavior. See [the production integration gate](../MIGRATION-PLAN.md) for validation and cutover requirements.
