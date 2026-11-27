# ADR-0015: Persistence equals readiness and reads are stale-while-revalidate

- **Status:** Accepted for provider-resource persistence; normalized-state/read behavior superseded by ADR-0018 and ADR-0020
- **Date:** 2026-11-21
- **Decision owners:** FieldView architecture
- **Scope:** EventRuntime, TeamRuntime, TaskScheduler, Worker read routes, browser synchronization

> **2026-11-22 clarification:** ADR-0018 supersedes the read-triggered initialization/revalidation behavior in this ADR. Public event/team state reads now return 404 until a valid canonical publication exists and never enqueue provider work. Once published, the last-good state remains readable while refresh runs.

> **2026-11-27 clarification:** Durable provider endpoint records and independently persisted analytics results remain the source of truth. EventState and TeamState are ephemeral normalized read projections; they are not persisted, are not readiness prerequisites, and are never generated as a side effect of bootstrap. Public reads construct the requested projection without storage writes, provider acquisition, task scheduling, or alarm changes. See ADR-0020.

## Context

FieldView persists provider resources, canonical state publications, analytics publications, and local task queues in Durable Object storage. Despite that persistence, client requests can still trigger initialization, state materialization, provider scheduling, and cross-runtime composition. This makes page latency depend on whether a runtime has recently been activated and whether its dependencies are warm.

A Durable Object's storage survives Worker restarts and deployments, but its in-memory objects do not. Durable Objects are activated on demand; there is no reliable process-wide callback that activates every entity when a Worker starts. The application must therefore restore each object's memory from its own durable records on activation, while maintaining mandatory global indexes through durable scheduled work.

The current season and its event list are not optional detail data. They are the base product index and must be available even when no visitor has opened a page.

## Decision

### 1. Reads return the last usable publication immediately

Public client GET requests are read-first and non-blocking:

1. Read the latest usable canonical publication from durable storage or a hydrated in-memory cache.
2. Return it immediately, including when its freshness metadata says stale.
3. If one or more inputs are stale, missing, or due for validation, enqueue local revalidation and arm the owning runtime's alarm.
4. Never wait for provider I/O, analytics calculation, or another Durable Object before returning a usable publication.

If no publication has ever existed, return a prompt explicit partial/unavailable response and schedule initialization. A refresh failure must never replace a previously usable publication with an empty or failed result.

### 2. Persistence is the readiness boundary

Persisted source records, canonical publications, revisions, validators, and task state must be sufficient to reconstruct the runtime's usable in-memory cache. A runtime is not considered ready merely because its Durable Object ID exists or Cloudflare reports hasStoredData.

Each runtime maintains explicit readiness metadata that distinguishes:
- durable source coverage;
- canonical publication existence, version, and completeness;
- in-memory hydration completion for the current activation;
- freshness and source provenance;
- pending revalidation work;
- last refresh failure and retry timing.

Hydration reads only the runtime's own durable storage. It must not fetch providers or call other runtimes.

### 3. Runtime-local activation and warm-up

On each activation:
- EventRuntime hydrates its own event state, endpoint metadata, canonical event publication, event-view publication, analytics publication, and local task queue.
- TeamRuntime hydrates its own team/season state, team-event projections, analytics publications, endpoint metadata, and local task queue.
- Hydration completes before requests can observe the in-memory cache. Use the platform's supported Durable Object initialization/concurrency primitive.
- Warm-up is restoration from persistence, not eager provider polling. Revalidation is queued independently after the last usable state is available.
- EventRuntime and TeamRuntime own their own warm-up, refresh scheduling, retry, and alarm behavior. TaskScheduler never warms entity caches.

Durable Objects are activated on demand, not all at Worker process startup. The guarantee is therefore per-object activation, not simultaneous instantiation of every entity.

### 4. Current season and event index are mandatory system state

The current season is a system invariant:
- The current season must always be discovered.
- A durable canonical index of the current season's known events must always exist and be served from persisted state.
- The index is updated through background discovery/reconciliation and committed atomically; client reads do not trigger discovery.
- System startup/recovery and the recurring system schedule must verify the current-season index and queue discovery if absent or stale.
- A failed discovery must preserve the previous usable event index.
- Historical seasons may be discovered on demand/admin request; the current season may not.

TaskScheduler owns this system-wide invariant and discovery orchestration. It does not own event/team entity data or hydrate those runtimes.

### 5. Detail refresh remains lazy

Event and team details need not be continuously refreshed while nobody is using them. Their last usable publication remains available indefinitely, with freshness metadata. A read of stale data returns that data and queues revalidation in the owning runtime. Active subscriptions or lifecycle policy may increase refresh cadence, but they do not change the read contract.

### 6. Event views and analytics are background publications

An ordinary event snapshot GET must not synchronously fan out to every TeamRuntime. EventRuntime serves its latest persisted complete or explicitly partial FieldViewEventView publication. TeamRuntime changes and roster reconciliation invalidate that publication and enqueue background composition. Event-wide analytics likewise calculate and publish asynchronously. A new publication replaces the old one atomically only after it is internally consistent for its declared coverage/revisions.

### 7. Statbotics testing endpoint

The official Statbotics API is currently unavailable. Retain `https://api-statbotics.iterativerefinement.com/` as the configured testing mirror until the official API is operational or a FieldView-operated compatible endpoint is ready. Do not change the configured mirror as part of this architecture work. Preserve endpoint/source provenance so test-mirror data is identifiable.

## Consequences

### Positive
- Worker restarts and Durable Object reactivation do not force provider refetches to restore usable state.
- Stale data remains available while background revalidation runs.
- Client latency is independent of provider availability and analytics computation.
- Event/team runtimes remain independently useful without TaskScheduler availability.
- The current season's event list is always available as durable product state.
- Readiness becomes measurable instead of inferred from object existence.

### Required implementation work
- Add activation-time storage hydration for EventRuntime and TeamRuntime.
- Refactor GET paths so they never publish, materialize, fetch providers, or synchronously call another runtime.
- Add durable stale-while-revalidate enqueue semantics that are idempotent and do not create repeated writes for every read.
- Persist a versioned event-view publication inside EventRuntime and update it asynchronously when team/event inputs change.
- Make TaskScheduler's current-season discovery invariant self-healing and independent of admin/manual discovery.
- Add readiness diagnostics and timing for hydration, durable reads, publication hits/misses, stale detection, queueing, provider refresh, and publication writes.
- Add tests for cold activation with pre-existing storage, stale reads during provider outage, no cross-runtime GET fan-out, failed refresh retaining prior publication, and missing/stale current-season index recovery.

## Non-goals

- Do not eagerly refresh every historical event or every team on Worker startup.
- Do not make TaskScheduler responsible for entity cache hydration or provider I/O.
- Do not block reads until the newest data is available.
- Do not remove the configured Statbotics testing mirror while the official API remains unavailable.
- No deployment, merge, production cutover, or Cloudflare resource change is implied by this decision.
