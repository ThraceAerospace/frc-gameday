# ADR-0007: EventRuntime state ownership and conditional polling

- **Status:** Accepted
- **Date:** 2026-11-17
- **Scope:** M4/M5 provider and runtime migration

## Context

FieldView receives TBA webhook notifications, polls TBA resources, enriches event data from other providers, and publishes shared event state to connected clients. These inputs can overlap and arrive out of order. HTTP validators, provider representations, local webhook changes, and canonical FieldView models have different ownership and must not be conflated.

## Decisions

### 1. EventRuntime is the event's authoritative state owner

Use one EventRuntime Durable Object per event as the initial consistency boundary. It owns event-scoped endpoint state, reconciliation, scheduling, canonical FieldView model composition, and publication. All state-changing inputs for that event—webhooks, poll responses, and administrative refreshes—must enter through this owner.

Do not create a Durable Object per endpoint, match, team, or domain interface. Add another runtime only when a distinct lifecycle or consistency boundary is demonstrated.

### 2. TBA provider client remains a stateless adapter

The TBA provider package owns authentication, base URL, provider-relative endpoint path builders, HTTP semantics, unchanged provider payloads, provider-specific types, and generated schemas. The Statbotics provider package owns its base URL, `/v3` transport prefix, provider-relative endpoint path builders, HTTP semantics, unchanged payloads, provider-specific types, and generated schemas.

It does not own durable cache state, ETag persistence, polling schedules, webhook reconciliation, or FieldView canonical state. It runs inside the Worker/DO execution environment as an ordinary adapter; it is not itself a Worker or Durable Object.

### 3. ETags belong to endpoint representations in EventRuntime storage

Persist each endpoint's exact latest HTTP provider representation (`providerData`) alongside its ETag, separately from the locally reconciled current representation (`data`). Each accepted HTTP 200 response is also retained as an immutable, revisioned provider source record in the EventRuntime ingestion layer. Webhook patches update `data` but never rewrite `providerData`, its validator, or the raw provider source version. An ETag validates one HTTP resource representation, not an individual match and not the locally reconciled FieldView model.

| Input | Data | ETag | Freshness |
| --- | --- | --- | --- |
| HTTP 200 with ETag | Accept/reconcile response | Replace validator | Refresh |
| HTTP 200 without ETag | Accept/reconcile response | Clear old validator | Refresh |
| HTTP 304 | Retain representation | Retain validator | Refresh |
| Failed request | Retain last good representation | Retain validator | Do not refresh successful-fetch time |
| Webhook | Reconcile affected local data | Retain validator | Do not claim an HTTP fetch occurred |

A webhook does not manufacture an ETag or make the upstream HTTP representation appear newer. The next conditional GET continues to use the validator supplied by TBA.

### 4. Polls reconcile against the latest state

Before network I/O, capture the endpoint revision and current ETag. Perform the fetch without holding a storage transaction or concurrency lock over network I/O. After the response arrives, enter a short storage transaction, reread the latest endpoint state, and reconcile the fetched representation against that latest state.

A changed revision is evidence that another input arrived while the request was in flight; it is not by itself a reason to discard the response. The endpoint-specific reconciliation function must preserve useful webhook changes while accepting unrelated new information from the poll. Commit the result and its validator atomically.

Use storage transactions for atomic read-modify-write. Do not hold a transaction or concurrency lock while calling TBA or another external service.

### 5. Durable scheduling is owned by the runtime

Each EventRuntime uses its Durable Object alarm to wake for due event-scoped tasks. Store multiple task deadlines and policies in durable storage; one alarm services the next due task and schedules the next wake. Poll cadence is runtime policy and can change with event lifecycle (pre-event, active qualification play, playoffs, completed/historical).

A Worker Cron Trigger handles global discovery and coordination: season/district/event discovery, initialization of event runtimes, and global maintenance. A separate scheduler Durable Object is deferred until durable queueing, batching, retries, or coordination demonstrably require it.

Statbotics is not a recurring poll source. A changed accepted TBA REST representation for an event, its teams/statuses, or its matches marks the corresponding Statbotics enrichment dirty and schedules a debounced fetch after a configurable settle delay. Each TBA-triggered refresh has a finite budget of four attempts: the initial request plus at most three retries. Transport/provider failures and HTTP 304 responses (the Statbotics representation has not changed after the triggering TBA update) retry with bounded exponential backoff; a successful changed representation completes the refresh. Exhaustion ends that refresh until another meaningful TBA representation change. Every failed or not-yet-current attempt preserves the last good value. Statbotics endpoints are not eligible for administrative recurring schedules.

### 6. Provider failure and partial availability are non-destructive

A failed or malformed refresh never erases a valid prior representation. A failure for one endpoint does not invalidate unrelated endpoint state. Missing, explicit null, authoritative clear, unavailable, stale, and failed remain distinct; endpoint adapters do not silently turn one state into another.

### 7. Canonical models remain the only application data model

EventRuntime composes and publishes the existing @fieldview/domain objects. Endpoint persistence records are infrastructure state, not a second canonical DTO/domain layer. HTTP and WebSocket transport serialize FieldView domain objects directly.

## Implementation sequence

1. Keep TBA HTTP transport in @fieldview/provider-tba; add provider-owned path builders.
2. Introduce platform-independent endpoint-state transition primitives and tests before binding them to Cloudflare storage.
3. Map legacy Redis cache behavior to endpoint-level state, validator, freshness, and failure semantics; do not migrate Redis abstractions into the provider package.
4. Add the Cloudflare Worker and EventRuntime Durable Object adapter around these pure transitions. The initial adapter persists current endpoint state and immutable source versions.
5. Verify TBA `X-TBA-HMAC` signatures over the exact raw request body at Worker ingress; persist/deduplicate raw notifications in EventRuntime and use notification types only for explicit local match updates or immediate endpoint refreshes. Then add global Cron discovery, canonical domain composition, and versioned client publication.
6. Validate duplicate/out-of-order webhooks, concurrent poll/webhook races, 304s, validator replacement/removal, failures, restarts, and reconnects before cutover.

## Consequences

- The provider package stays portable and testable.
- Event-scoped consistency has one authoritative owner.
- ETags remain correctly scoped to provider HTTP resources.
- The first implementation can be tested without Cloudflare dependencies.
- An initial Worker entrypoint, SQLite-backed EventRuntime binding, endpoint persistence, immutable source-version records, internal webhook-update route, and alarm-driven TBA polling adapter are implemented in the migration branch. TBA `X-TBA-HMAC` verification and event-scoped notification ingestion are implemented. Event/team/event-team/match/playoff-alliance snapshot composition is implemented through `@fieldview/domain` normalizers. Statbotics match enrichment is TBA-change-driven and one-shot; it is not polled. Analytics recalculation is planned as a separate coalesced batch (10-minute initial target, with a 5-minute option) and remains outside this runtime implementation. Global discovery, browser-facing subscription credentials, runtime secrets, and deployment remain future work; the internal WebSocket handshake, hibernating subscription, and revision-notification lifecycle are implemented. No Worker or Durable Object is deployed.


### Versioned event subscriptions

The EventRuntime exposes a public, read-only `GET /stream` WebSocket upgrade alongside public `GET /snapshot`. No user account, login, or browser-held service credential is required. The Worker exposes these through `/events/:eventKey/stream` and `/events/:eventKey/snapshot`; its internal administrative and mutation routes remain protected by the runtime admin bearer token. The connection begins with a `connected` message containing the event key, current snapshot revision, and `snapshot_required`. A client may supply its last applied revision as `?since=N`; because the runtime does not retain a replay log, any revision mismatch requires a canonical snapshot fetch. After each committed snapshot mutation, subscribers receive only a `snapshot.changed` notification with the new revision. They then fetch `/snapshot` and apply it only if its `X-FieldView-Snapshot-Version` is not older than their current state. If notifications arrive during a snapshot fetch, clients compare the returned revision with the highest notification seen and fetch again when necessary. Reconnect repeats this handshake; missed notifications are repaired through the same snapshot fallback. The WebSocket is accepted through Durable Object hibernation APIs. Public access is intentionally limited to read-only event snapshots and revision notifications; no schedule, state-inspection, webhook, or other mutation operation is exposed through the public route. The admin bearer token remains server-side for administrative and service-to-service operations. This is a public transport seam; frontend consumption and deployment remain separate work.
