# Architecture decision: Discovery, System Records, and Runtime State

- **Status:** Accepted, clarified by ADR-0020
- **Date:** 2026-11-24
- **Scope:** Cloudflare storage domains, runtime ownership, and polling orchestration

ADR-0020 is authoritative wherever this decision's earlier language about persisted normalized state, Workflow provider ownership, or readiness conflicts with it.

## Storage domains

FieldView separates three data domains:

### Discovery
D1 is authoritative for event/team discovery directories, current-season metadata, weekly event candidates, and discovery refresh metadata. KV may hold lightweight read-heavy projections where its consistency model is sufficient.

### System Records
D1 stores FieldView's operational records: Workflow execution/progress/outcomes, runtime registration, administrative actions, and durable operational history. System Records has a separate repository and ownership boundary from Discovery, even when both use the same physical D1 database.

### Runtime State
EventRuntime and TeamRuntime Durable Objects own canonical provider endpoint records and scope-local canonical data. EventRuntime owns event-scoped provider resources and event facts; TeamRuntime owns team/year-scoped provider resources and team facts. Multiplexer owns subscription coordination; RemoteSessionRuntime owns remote-display session signaling.

EventState and TeamState are not persisted canonical records. They are ephemeral normalized projections derived from provider endpoint records at read time, as defined by ADR-0020.

## Runtime abstraction and ongoing refresh ownership

EventRuntime and TeamRuntime implement the same runtime lifecycle at different scopes. Each runtime:
1. Accepts explicit refresh commands for its own identity and scope.
2. Loads its own provider endpoint records and validators.
3. Fetches its own provider resources using conditional validators where supported.
4. Reconciles accepted responses against its latest durable working state.
5. Persists meaningful changes and required recovery metadata.
6. Publishes versioned, data-bearing changes when appropriate.
7. Preserves last-good data on failed or partial acquisition and treats HTTP 304 as a strict no-op for payload state.

Neither runtime fetches or persists resources owned by the other. Cross-runtime dependencies use explicit versioned references or operation-specific inputs, not ownership transfer or duplicated canonical aggregates.

## First-registration bootstrap exception

ADR-0020 clarifies a narrow exception to runtime-owned provider acquisition: when an EventRuntime or TeamRuntime is first registered/created, its initialization Workflow may perform one bounded, idempotent acquisition of the initial provider endpoint resources required to hydrate that runtime reliably. The Workflow imports those endpoint records into the owning Durable Object.

This exception:
- is tied to first registration/creation;
- exists specifically to ensure reliable initial runtime hydration;
- persists provider endpoint records and their acquisition metadata only;
- does not materialize EventState or TeamState;
- does not become a recurring refresh or retry proxy.

After bootstrap, all ongoing provider acquisition belongs to the owning runtime. Workflows may orchestrate operations, but the polling coordinator dispatches explicit refresh commands and does not fetch provider resources.

## Polling coordinator and direct dispatch

A single polling coordinator within the consolidated Worker determines which runtime identities are due for refresh. It owns lifecycle eligibility, target selection, bounded concurrency, overlap prevention, prioritization, and aggregate operation budgets.

For each eligible runtime, the coordinator dispatches an explicit command. It does not fetch provider resources, reconcile canonical state, or construct provider deltas. Each runtime performs its own acquisition, validators, reconciliation, persistence, and publication.

Direct bounded dispatch is the default. Cloudflare Queues are not part of the refresh path. Reconsider a Queue only if measured throughput, backpressure, or reliability requirements justify its operational and quota costs.

## Readiness and public reads

Initialization Workflows register new runtime identities and perform the one-time bootstrap described above. Their durable outcomes record whether the initial provider endpoint resources were acquired and imported.

Public reads do not initialize runtimes, acquire providers, schedule work, or write Durable Object storage. A read of EventState or TeamState derives the projection from the owning runtime's provider endpoint records. Readiness is not gated on a persisted normalized-state publication.

## Architectural boundaries

1. Discovery owns discovery data only.
2. System Records owns records about system operations, not canonical event/team data.
3. EventRuntime and TeamRuntime own their respective provider endpoint records and scope-local canonical facts.
4. Cross-runtime references are logical references resolved through owner interfaces; callers do not access another runtime's SQLite storage.
5. KV is for lightweight projections and pointers, not canonical provider records or transactional coordination.
6. Persistent reads remain side-effect-free. No hidden writes, lazy initialization, TTL refreshes, read-time migrations, or unchanged-state rewrites.
7. Persistent mutations are explicit, auditable, and attributable to an operation.
8. Storage workloads and usage budgets are reviewed independently for D1, KV, and Durable Objects.

## Consequences

This separation keeps provider acquisition with the runtime that owns the data after initialization, keeps discovery and operations out of runtime storage, and avoids making client reads depend on previously materialized normalized state. The first-registration exception solves the observed cold-hydration problem without creating a second ongoing provider-acquisition system.

See [ADR-0020](../decisions/ADR-0020-ephemeral-state-projections-and-snapshot-first-stream.md) for the complete read/realtime contract and [the production integration gate](../MIGRATION-PLAN.md) for validation requirements.
