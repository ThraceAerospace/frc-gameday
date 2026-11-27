# ADR-0020: Ephemeral normalized state and snapshot-first realtime

- **Status:** Accepted
- **Date:** 2026-11-27
- **Scope:** EventRuntime, TeamRuntime, provider-resource acquisition, D1 discovery records, browser realtime, final migration integration
- **Supersedes:** ADR-0013's persisted browser cache and fetch-after-notify recovery rules; the publication/readiness assumptions in ADR-0015; the publication and reconnect clauses in ADR-0008
- **Clarifies:** ADR-0016's separation of canonical owner data from temporary analytics inputs

## Context

The migration branch is a clean-slate implementation. None of its Cloudflare resources have been deployed, and there is no production data, queue backlog, Redis state, or legacy runtime state to preserve. Retaining compatibility code for those systems adds alternate read/write paths and makes the final integration contract difficult to verify.

The previous implementation still contained several unnecessary layers: persisted normalized EventState/TeamState publications and fallback reads, workflow bootstrap that materialized state before a client asked for it, browser IndexedDB snapshots, WebSocket-triggered HTTP recovery, an EventRuntime-specific stream alongside the Multiplexer, and an R2-shaped generic discovery record HTTP API.

## Decision

### 1. Provider endpoint records are the durable source of truth

- EventRuntime owns event-scoped TBA and Statbotics endpoint records, validators, acquisition status, freshness, and revisions.
- TeamRuntime owns team/year-scoped provider endpoint records and their acquisition metadata.
- Workflow bootstrap acquires missing provider endpoint resources only. It does not generate or persist EventState or TeamState.
- The polling coordinator and explicit refresh commands own subsequent acquisition. Reads do not acquire providers, schedule work, mutate readiness, or write Durable Object storage.

### 2. EventState and TeamState are ephemeral normalized read projections

- A client read of `/events/:eventKey/snapshot` constructs EventState from EventRuntime's stored endpoint records.
- A client read of `/teams/:teamKey/snapshot?year=YYYY` constructs TeamState from TeamRuntime's stored endpoint records.
- The projection may be retained in disposable Durable Object memory as a hot cache when its source signature still matches.
- The current implementation does not persist normalized EventState or TeamState. No read path assumes a projection exists in durable storage.
- A cold read or Durable Object eviction simply regenerates the projection from provider endpoint records. It must not write rows as a side effect.
- A projection is not a readiness prerequisite. Readiness is determined from endpoint acquisition records.

Persisted analytics results and TeamEventState records remain separate, purpose-specific analytics data. They are not substitutes for EventState or TeamState and do not make a normalized state publication mandatory.

### 3. Realtime is snapshot-first and data-bearing

- The browser performs the canonical HTTP snapshot read before opening the shared `/stream` WebSocket.
- The public `/stream` route is owned only by Multiplexer. EventRuntime and TeamRuntime do not expose parallel event-scoped WebSocket routes.
- EventRuntime sends data-bearing event snapshot or team-event patch notifications to Multiplexer. Analytics notifications carry their committed analytics publication.
- The SharedWorker applies valid, ordered data-bearing notifications to its in-memory cache.
- WebSocket acknowledgements, notifications, gaps, disconnects, and reconnects never trigger an HTTP snapshot or analytics refetch. Reconnect only restores subscriptions.
- An explicit user refresh or a new page/client read may perform another HTTP read.
- The SharedWorker does not persist normalized snapshots in IndexedDB. Durable provider records and independently persisted analytics results remain authoritative.

### 4. Discovery uses direct D1 record contracts

- Discovery and operational records are stored in their owning D1 repositories.
- In-process callers use typed record methods for JSON reads, writes, and key listings.
- There is no generic R2 object-body/metadata contract and no HTTP `/get`, `/put`, or `/list` storage API.
- Discovery catalog acquisition remains a domain operation; it is not a generic storage endpoint.

### 5. Retired architecture is removed, not bridged

The final implementation has no Redis/ioredis cache or Pub/Sub, Vercel WebSocket bridge, Vercel TBA webhook relay, web-side provider acquisition, R2 binding, Queue producer/consumer, Durable Object alarm polling, persisted normalized-state fallback, IndexedDB normalized-state cache, or per-event compatibility stream. Do not reintroduce adapters for these retired systems.

## Consequences

- Initial event/team reads are deterministic and independent of whether a normalized projection was previously materialized.
- Reads can be tested for zero Durable Object writes, including after cache eviction.
- Workflow readiness can finish when provider endpoint records have been acquired; it does not need to create a client-facing projection.
- EventState and TeamState contracts stay distinct from provider endpoint storage and from analytics-specific TeamEventState.
- Realtime delivery does not cause hidden HTTP reads. The stream carries the changed data, and the client does not infer that a notification is merely an instruction to refetch.
- The only browser cache is in-memory within the SharedWorker; reloading a client starts with a fresh canonical HTTP read.

## Required final integration tests

1. Cold EventRuntime and TeamRuntime snapshot reads construct normalized state from provider endpoint records and perform zero storage writes.
2. Repeated reads, in-memory cache hits, and Durable Object cache eviction preserve the same contract and perform zero read-path writes.
3. Workflow bootstrap stores provider endpoint records only and does not construct EventState or TeamState.
4. EventRuntime and TeamRuntime do not register Durable Object alarm handlers or schedule alarms.
5. Browser request order is HTTP snapshot first, then the single shared `/stream` connection.
6. Data-bearing event, team-event, and analytics WebSocket messages update the SharedWorker cache without triggering HTTP reads; reconnect only resends subscriptions.
7. The Worker exposes one public Multiplexer stream and no per-event EventRuntime stream.
8. Discovery callers use direct D1 JSON-record methods; the generic R2-shaped `/get`, `/put`, and `/list` routes are absent.
9. The full workspace typecheck, test suite, D1 schema validation, Wrangler dry run, and deployed Preview end-to-end checks pass before merging to `main`.

## Deployment state

This ADR describes the intended final architecture on `fieldview-architecture-migration`. No branch resources have been deployed. The next gate is final integration testing against a clean Cloudflare Preview resource baseline. This ADR does not authorize a production deployment.
