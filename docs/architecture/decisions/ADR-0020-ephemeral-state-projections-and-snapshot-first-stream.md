# ADR-0020: Ephemeral normalized state and snapshot-first realtime

- **Status:** Accepted
- **Date:** 2026-11-27
- **Scope:** EventRuntime, TeamRuntime, provider-resource acquisition, D1 discovery records, browser realtime, final integration
- **Supersedes:** ADR-0013's persisted browser cache and fetch-after-notify recovery rules; the publication/readiness assumptions in ADR-0015; the publication and reconnect clauses in ADR-0008
- **Clarifies:** ADR-0016's separation of canonical owner data from temporary analytics inputs

## Context

The target implementation stores upstream provider endpoint responses in the Durable Object that owns the corresponding event or team. FieldView's normalized EventState and TeamState are client-facing read projections; they should be derived when requested rather than materialized as durable publications merely to make an initial read possible.

Realtime follows the same source-of-truth model. The initial HTTP snapshot establishes the client's starting state and revision. Later stream messages carry the changed data. A notification that contains only a revision or invalidation marker would force the client to make another HTTP request and would recreate the fetch-after-notify behavior this decision removes.

## Decision

### 1. Provider endpoint records are the durable source of truth

- EventRuntime owns event-scoped TBA and Statbotics endpoint records, validators, acquisition status, freshness, and revisions.
- TeamRuntime owns team/year-scoped provider endpoint records and their acquisition metadata.
- **First-registration bootstrap exception:** when a runtime is first registered/created, its initialization Workflow may perform a one-time, bounded acquisition of the provider endpoint resources required to hydrate that runtime. The Workflow passes the acquired endpoint records to the owning runtime for durable storage. This exception exists because first-time runtime hydration through the ordinary refresh lifecycle was not reliably completing.
- Bootstrap is tied to first registration/creation, is idempotent, and is not an alternate recurring provider path. It must not construct or persist EventState or TeamState.
- Once bootstrap completes, all ongoing provider acquisition is owned by EventRuntime or TeamRuntime. The polling coordinator and explicit refresh commands initiate subsequent acquisition; Workflows may orchestrate a refresh but must not become a recurring provider proxy.
- Reads do not acquire providers, schedule work, mutate readiness, register runtimes, or write Durable Object storage.

### 2. EventState and TeamState are ephemeral normalized read projections

- A client read of `/events/:eventKey/snapshot` constructs EventState from EventRuntime's stored endpoint records.
- A client read of `/teams/:teamKey/snapshot?year=YYYY` constructs TeamState from TeamRuntime's stored endpoint records.
- The projection may be retained in disposable Durable Object memory as a hot cache when its source signature still matches.
- EventState and TeamState are not persisted as canonical records. No read path assumes a projection exists in durable storage.
- A cold read or Durable Object eviction regenerates the projection from provider endpoint records and performs no Durable Object storage write.
- A projection is not a readiness prerequisite. Runtime initialization/readiness is based on registration and provider endpoint acquisition records.

Persisted analytics results and TeamEventState records remain separate, purpose-specific analytics data. They are not substitutes for EventState or TeamState and do not make a normalized state publication mandatory.

### 3. Realtime is snapshot-first and data-bearing

- The browser performs the canonical HTTP snapshot read before opening the shared `/stream` WebSocket.
- The public `/stream` route is owned only by Multiplexer. EventRuntime and TeamRuntime do not expose parallel event-scoped WebSocket routes.
- EventRuntime and TeamRuntime publish data-bearing state changes through Multiplexer. An event snapshot update carries the updated EventState data; a team-event update carries the changed patch/data and its scope. Analytics notifications carry the committed analytics publication.
- Every message includes the identity and ordering/revision metadata required to apply it safely relative to the initial snapshot and prior messages.
- A revision-only notification or invalidation is not a valid state-change publication.
- The SharedWorker applies valid, ordered data-bearing notifications to its in-memory cache.
- WebSocket acknowledgements, notifications, gaps, disconnects, and reconnects never trigger an HTTP snapshot or analytics refetch. Reconnect restores subscriptions only.
- A new page/client read or explicit user refresh may perform another HTTP read.
- The SharedWorker does not persist normalized snapshots in IndexedDB. Durable provider records and independently persisted analytics results remain authoritative.

### 4. Discovery uses direct D1 record contracts

- Discovery and operational records are stored in their owning D1 repositories.
- In-process callers use typed record methods for JSON reads, writes, and key listings.
- There is no generic R2 object-body/metadata contract and no HTTP `/get`, `/put`, or `/list` storage API.
- Discovery catalog acquisition remains a domain operation; it is not a generic storage endpoint.

### 5. Retired architecture is removed, not bridged

The target architecture has no Redis/ioredis cache or Pub/Sub, Vercel WebSocket bridge, Vercel TBA webhook relay, web-side provider acquisition, R2 binding, Queue producer/consumer, Durable Object alarm polling, persisted normalized-state fallback, IndexedDB normalized-state cache, or per-event compatibility stream. Do not reintroduce adapters for these retired systems.

## Consequences

- Initial event/team reads are derived from provider endpoint records and do not depend on a normalized publication having been materialized earlier.
- Reads can be tested for zero Durable Object writes, including after cache eviction.
- First-registration Workflow bootstrap solves initial hydration without creating a second ongoing provider-acquisition owner.
- EventState and TeamState remain distinct from provider endpoint storage and analytics-specific TeamEventState.
- Realtime delivery never causes hidden HTTP reads. The stream carries the changed data, and clients do not interpret notifications as instructions to refetch.
- Reloading a client starts with a fresh canonical HTTP snapshot; the SharedWorker then applies data-bearing updates.

## Integration invariants

1. First-registration bootstrap is one-time, bounded, idempotent, and persists provider endpoint records only.
2. Subsequent provider refreshes are executed by the owning EventRuntime or TeamRuntime.
3. Cold/warm/evicted snapshot reads return the same projection contract and perform zero storage writes.
4. The browser obtains the HTTP snapshot before subscribing to the single Multiplexer stream.
5. Event, team-event, and analytics stream messages carry the actual changed data plus ordering metadata.
6. Notifications, gaps, and reconnects do not trigger HTTP reads.
7. No Durable Object alarm polling, Queue refresh path, R2 discovery API, Redis bridge, or IndexedDB normalized-state persistence is introduced.

## Deployment

This ADR defines the target architecture. Production deployment is a separate operator-controlled cutover after the integration gate in [MIGRATION-PLAN.md](../MIGRATION-PLAN.md) is satisfied.
