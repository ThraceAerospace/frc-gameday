# ADR-0014: Runtime-local execution and cross-runtime orchestration

- **Status:** Accepted
- **Date:** 2026-11-21
- **Decision owners:** FieldView architecture
- **Scope:** Cloudflare Worker, EventRuntime, TeamRuntime, TaskScheduler

## Context

EventRuntime and TeamRuntime already have independent Durable Object storage, durable task records, alarms, retry state, and provider adapters. At the same time, TaskScheduler coordinates work that spans multiple entities, including discovery, lifecycle classification, roster reconciliation, season ingestion, and event-team seeding.

The previous implementation blurred these responsibilities. In particular, EventRuntime's event analytics input collection called the global TaskScheduler once for each participating team merely to register that team. Worker admin routes also registered runtimes on ordinary refresh operations. Those requests did not perform useful orchestration; they added hot-path traffic and made local runtime work depend on a global inventory write.

The team seed path also coordinated TeamRuntime and multiple EventRuntimes directly in the Worker entrypoint. That put cross-runtime orchestration in the transport layer instead of the scheduler.

## Decision

### 1. Entity runtimes own execution

EventRuntime owns all event-scoped work and its execution lifecycle:
- event provider acquisition and conditional revalidation;
- event state reconciliation and persistence;
- webhook-triggered follow-up work;
- event analytics invalidation, calculation, and publication;
- local durable task queues, alarm scheduling, retries, and backoff.

TeamRuntime owns all team-scoped work and its execution lifecycle:
- team, season, and team-event provider acquisition;
- team state and team-event projection reconciliation/persistence;
- team analytics invalidation, calculation, and publication;
- local durable task queues, alarm scheduling, retries, and backoff.

A runtime may expose a command endpoint for an authorized trigger. The runtime decides how that command maps to its own durable queue/alarm and performs the work. The runtime remains the authoritative writer for its data.

### 2. TaskScheduler owns orchestration, not entity execution

TaskScheduler is responsible for work that spans multiple runtimes or the system as a whole:
- discovering the set of entities that need work;
- selecting and ordering target runtimes;
- persisting job progress, cursors, retry timing, and bounded batch state;
- dispatching commands to EventRuntime and TeamRuntime;
- coordinating lifecycle transitions, roster reconciliation, season ingestion, and cross-runtime seeding;
- maintaining the global inventory needed by administrative coverage and operational views.

TaskScheduler triggers jobs; target runtimes execute them. TaskScheduler must not proxy provider requests for an entity, reconcile that entity's canonical state, or own its recurring poll schedule. It may read a runtime's published state to decide what cross-runtime command is needed.

### 3. No per-read registration

A runtime must not call TaskScheduler during an ordinary snapshot, analytics, state, or refresh request merely to register itself. The per-request /register endpoint is removed. TaskScheduler populates and updates its inventory through its own discovery and cross-runtime orchestration workflows. Inventory is operational metadata, not a prerequisite for a runtime to serve its own state.

### 4. Admin jobs are asynchronous and alarm-driven

An admin request is a submission boundary, not an execution boundary:

1. Validate the command and persist a job record with a stable identity, status, progress cursor, retry timing, and timestamps.
2. Arm the TaskScheduler alarm and return HTTP 202 with the accepted job state. Do not fetch provider data, wait for a runtime alarm, or iterate across target runtimes in the request handler.
3. TaskScheduler advances cross-runtime jobs in bounded alarm steps. Each step dispatches a command to the owning runtime and persists its cursor/progress before yielding.
4. EventRuntime and TeamRuntime enqueue local work and return immediately. Their own alarms execute provider I/O, reconciliation, publication, and retries.
5. Read-only admin status routes return persisted job state. The dashboard polls status independently; a running job must never keep an HTTP request or global dashboard busy state open.
6. Routine scheduler stop disables periodic work only. It must preserve alarms for already accepted admin jobs.

This applies to team seeding, event-team seeding, manual discovery, full-season ingestion, and coverage audits. Manual /run, /daily, and historical season discovery are also queue operations. Event lifecycle changes, resource refreshes, and team seed commands must not invoke alarm handlers inline or synchronously fan out from EventRuntime to TeamRuntime.

### 5. Cross-runtime operations enter through TaskScheduler

The Worker remains a stateless routing/authentication boundary. It forwards cross-runtime admin commands to TaskScheduler. TaskScheduler persists or executes the orchestration and dispatches commands to the appropriate runtimes.

The team seed flow is the first application of this rule:
1. Worker forwards the authorized team seed command to TaskScheduler.
2. TaskScheduler triggers TeamRuntime to seed its own resources and reads the resulting canonical team event history.
3. TaskScheduler dispatches schedule/lifecycle commands to each associated EventRuntime.
4. TeamRuntime and EventRuntime perform their respective work using their own storage, queues, alarms, provider clients, and retry semantics.

Single-runtime admin operations may still be forwarded directly from Worker to the owning runtime; they do not need to pass through TaskScheduler.

## Consequences

### Positive
- Ordinary event analytics reads no longer generate one global scheduler request per roster team.
- Direct refreshes no longer incur a separate global registration request.
- Cross-runtime workflows have one durable orchestration owner and explicit progress.
- Entity runtimes remain independently executable and recoverable.
- Global discovery and inventory remain centralized without centralizing entity data execution.

### Trade-offs
- TaskScheduler remains a coordination point for genuinely cross-runtime workflows and must keep those jobs bounded and resumable where their scale requires it.
- Inventory may not immediately include an entity that was created only by a direct single-runtime admin operation. This is acceptable: inventory must not be required for runtime correctness; discovery and orchestration populate it.
- A TaskScheduler outage can delay cross-runtime orchestration, but it must not prevent an already initialized EventRuntime or TeamRuntime from serving its own cached state or executing its local scheduled work.

## Implementation notes

- Removed per-read team registration from EventRuntime analytics input collection.
- Removed Worker registration calls from direct event/team admin routes and removed TaskScheduler's /register endpoint.
- Routed team seed through TaskScheduler's /admin/team-seed endpoint; the scheduler triggers TeamRuntime and then dispatches to associated EventRuntimes.
- Updated scheduler inventory in batched writes as part of that orchestration.
- Preserved existing EventRuntime and TeamRuntime local alarm/task implementations.
- No deployment, merge, production cutover, or change to external secrets is implied by this decision.
