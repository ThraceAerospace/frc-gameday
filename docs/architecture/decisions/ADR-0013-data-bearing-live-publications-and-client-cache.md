# ADR-0013: Data-bearing live publications and validator-backed client cache

- **Status:** Superseded by ADR-0020 (historical design only)
- **Date:** 2026-11-21
- **Supersedes:** The revision-only delivery rule in ADR-0008; it does not change the one-SharedWorker/one-Multiplexer connection model.

> **2026-11-27 supersession:** This proposal's IndexedDB cache, persisted normalized-state assumptions, fetch-after-notify behavior, and conditional HTTP recovery on WebSocket gaps/reconnects are not part of the final architecture. ADR-0020 replaces them with ephemeral EventState/TeamState read projections, a memory-only SharedWorker cache, snapshot-before-stream ordering, and data-bearing notifications that never trigger HTTP refetches. Do not implement the rollout steps below.

## Context

The current canonical browser transport sends revision-only `snapshot.changed` and `analytics.changed` messages. The SharedWorker then fetches the complete HTTP resource after every notification. This repeats payload transfer and read work even though EventRuntime already persists a normalized event-state publication and analytics publication.

The event snapshot endpoint also composes independently owned TeamRuntime event projections. Fetching it after every event notification can fan out into one read per participating team. The client currently bypasses validators with `cache: "no-store"`, and the runtime read endpoints do not consistently expose client-facing ETags.

The browser needs a durable local cache, ordered live updates, and a cheap recovery path without making the Multiplexer a second canonical state owner.

## Decision

### Ownership and transport

- EventRuntime remains authoritative for event-owned `FieldViewEventState` and event-wide analytics publication.
- TeamRuntime remains authoritative for each `FieldViewTeamEventState` and team-scoped analytics.
- The Multiplexer remains a transient connection/subscription router. It does not persist or own canonical snapshots.
- The SharedWorker remains the single browser-origin synchronization owner and persists client DTO cache entries in IndexedDB.
- Provider webhooks remain acquisition/reconciliation inputs; never forward raw provider webhook payloads as client state.

### WebSocket publication envelope

A live publication carries the committed FieldView DTO data for the changed resource, not merely an invalidation notice. Every envelope includes:

- protocol/schema version;
- topic and resource identity;
- monotonically increasing resource revision;
- change kind (`snapshot` or `patch`);
- the canonical FieldView DTO payload;
- optional validator/ETag metadata.

EventRuntime publishes its current normalized event-owned state when the event-state revision changes. A TeamRuntime event-state change notifies EventRuntime with both the team-season source revision and the independent team-event projection revision. EventRuntime retrieves only that team's committed `FieldViewTeamEventState` and publishes the scoped patch alongside the new event snapshot revision. This preserves EventRuntime's composition/version boundary without relaying provider webhooks or reading every team. Analytics publication sends the committed versioned analytics publication. No raw TBA/Statbotics payloads are exposed.

The SharedWorker applies only newer revisions. It merges a team-event patch by `team_key` without replacing other teams. If a revision gap, invalid payload, schema mismatch, or missing base snapshot prevents a safe merge, it retains the last good cache and performs conditional HTTP recovery for that resource.

The Multiplexer forwards payloads only to clients subscribed to the matching topic/resource. It must not store publication bodies or replay an unbounded history.

### HTTP validators and recovery

- Canonical event snapshots, TeamRuntime team/season snapshots, and analytics reads expose stable ETags derived from their public resource revisions and relevant composition/status revisions.
- Clients send `If-None-Match` using the validator stored with their cached representation.
- A matching validator returns `304 Not Modified` without serializing the body or fanning out to TeamRuntime for the composed snapshot.
- A changed validator returns the current DTO and ETag.
- A team-state patch advances the composed event snapshot revision so an event snapshot validator cannot remain valid after a team projection changes.
- Cache directives require revalidation; they do not permit an intermediary to serve stale live data without checking.
- ETags are opaque validators, not ordering tokens. Resource revisions remain the ordering mechanism.

### Client cache

- IndexedDB stores versioned canonical DTOs and their ETags, keyed by resource identity and schema version.
- The SharedWorker hydrates memory from IndexedDB, distributes cached state to tabs immediately, and owns network validation and live update application.
- Tabs do not independently fetch providers or open additional runtime WebSockets.
- IndexedDB is a recoverable client cache, never an authority. On corruption, schema incompatibility, storage eviction, or a revision gap, fetch the canonical HTTP resource.
- Do not persist transient connection state, credentials, or provider secrets.

### Read/write efficiency

- Do not perform a full snapshot HTTP read for a complete data-bearing WebSocket publication.
- Do not read every TeamRuntime projection merely to validate a snapshot the client already has; evaluate the event snapshot ETag before composing team states.
- Keep EventRuntime and TeamRuntime writes scoped to actual changed data. Duplicate or unchanged notifications must not advance revisions.
- Keep analytics revisions independent from event-state revisions.
- Do not add Multiplexer storage writes for publication payloads.

## Rollout and compatibility

Implement incrementally:
1. Add ETags and conditional 304 handling to canonical snapshot and analytics reads.
2. Extend the existing Multiplexer notification envelope to carry optional committed DTO data; keep revision-only compatibility during rollout.
3. Publish event-owned state and analytics data; add team-event patch publication without relaying through EventRuntime.
4. Teach SharedWorker to apply ordered payloads and recover gaps with conditional HTTP reads.
5. Add IndexedDB persistence and hydration; validate multi-tab behavior and cache invalidation.
6. Remove revision-only fetch-after-notify behavior only after the data-bearing path is covered by tests.

No production cutover is authorized by this ADR. Preserve the legacy path until preview parity and reconnect/recovery behavior are validated.

## Required tests

- ETag match returns 304 without TeamRuntime reads or response serialization.
- Changed event/team/analytics revision produces a changed ETag.
- WSS carries only committed, scope-owned FieldView DTO data to subscribed clients.
- Unsubscribed clients receive no data.
- Duplicate/out-of-order publications cannot overwrite newer client cache entries.
- Team-event patches update one team while preserving other teams and event-owned state.
- Revision gaps, reconnects, IndexedDB misses, and 304 responses recover without losing the last good state.
- Schema-version mismatch triggers a full canonical read.
- IndexedDB failure degrades to in-memory cache and HTTP recovery without breaking live updates.
