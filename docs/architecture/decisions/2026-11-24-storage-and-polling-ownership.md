# Architecture Decision: Separate Discovery, System Records, and Runtime State

- **Status:** Accepted
- **Date:** 2026-11-24
- **Scope:** FieldView Cloudflare architecture migration
- **Applies to:** All environments
- **Decision authority:** FieldView project owner

> All contrary provisions are abrogated.

This decision supersedes any earlier architecture notes, implementation assumptions, or plans that assign workflow records, runtime registrations, system logs, or other operational records to DiscoveryStore, or that require a central polling process to fetch TBA resources and construct EventRuntime deltas.

## Decision

FieldView has three distinct data domains: **Discovery**, **System Records**, and **Runtime State**. Each has a defined purpose, owner, and storage responsibility. They must not be combined merely for implementation convenience.

### 1. Discovery

**Purpose:** Maintain information about the events and teams FieldView knows about and the discovery metadata used to determine what the system should process.

Responsibilities:
- Event and team discovery directories.
- Current-season metadata.
- TBA `/status`-derived discovery information.
- The weekly event candidate list, `events-this-week`.
- Discovery refresh metadata and results.

**Storage:** Cloudflare D1 is the authoritative discovery store. Workers KV may hold lightweight, read-heavy projections, such as `events-this-week`, where its consistency model is sufficient.

DiscoveryStore (or its successor repository) is exclusively for discovery. It is not a general-purpose operational database.

### 2. System Records

**Purpose:** Maintain durable, queryable records describing FieldView's own operations.

Responsibilities:
- Workflow execution records, progress summaries, and outcomes.
- Runtime registration and operational records.
- Administrative actions and their outcomes.
- Structured system events and operational history.
- Other durable records describing what the system has done.

**Storage:** Cloudflare D1, through a System Records repository and schema logically separate from Discovery.

System Records must have independent retention policies appropriate to each record type.

High-volume diagnostic logs do not automatically belong in D1. Detailed execution diagnostics may be better suited to Workers Logs or another dedicated logging facility. D1 should contain durable operational records that FieldView needs to query and retain.

### 3. Runtime State

**Purpose:** Own canonical state and coordination for individual events and teams.

Responsibilities:
- Canonical EventState and TeamState.
- Provider endpoint state and ETags.
- Canonical revisions and snapshots.
- Provider-response reconciliation and delta generation.
- Runtime-specific coordination and persistence.
- Multiplexer subscription and connection coordination.

**Storage:** Durable Objects with SQLite-backed storage.

EventRuntime and TeamRuntime remain authoritative for their respective canonical state. Multiplexer Durable Objects remain responsible for real-time subscription coordination.

## Runtime abstraction and refresh ownership

EventRuntime and TeamRuntime are two scopes of the same runtime abstraction. They are not separate architectural patterns. Both implement the same lifecycle and refresh contract; their differences are limited to identity, owned resources, canonical state, reconciliation rules, and scope-specific derived outputs.

The shared runtime contract is:
1. Accept an explicit refresh command for the runtime's own identity and scope.
2. Load its own canonical working state and persisted provider validators.
3. Fetch its own provider resources directly, using applicable conditional validators.
4. Reconcile accepted responses against its latest working state.
5. Persist only meaningful canonical changes and required recovery checkpoints.
6. Publish versioned, data-bearing changes when appropriate.
7. Preserve last-good canonical state on failed or partial acquisition, and treat HTTP 304 as a strict no-op.

EventRuntime owns event-scoped resources and canonical event state. TeamRuntime owns team-scoped resources, team/season state, team/event state, and team-scoped analytics. Neither runtime fetches or persists resources owned by the other. Cross-runtime dependencies use explicit versioned references or operation-specific inputs, not ownership transfer.

### Polling coordinator and direct dispatch

A single polling coordinator (implemented within the consolidated FieldView Worker deployment) determines which runtime identities need refresh and when. It is responsible for lifecycle eligibility, bounded concurrency, overlap prevention, prioritization, and aggregate operation budgets. It does not fetch provider resources, reconcile canonical state, or construct runtime deltas.

For each eligible event, the coordinator sends a refresh command to that EventRuntime. When an event update affects team-scoped projections, the coordinator identifies the affected team keys and sends refresh commands to those TeamRuntimes as well. The EventRuntime does not relay webhooks or dispatch work to TeamRuntime; scope routing belongs at the coordinator/Worker ingress boundary.

EventRuntime refresh does not automatically imply refreshing every participating TeamRuntime. Only teams whose owned projections are affected should be dispatched. Event participant rosters and match alliance membership can provide the affected team set where appropriate.

Direct bounded dispatch is the default. A Queue is not required merely to batch runtime refresh requests. Do not introduce Queue infrastructure, message persistence, deduplication, retry, and consumer machinery without measured evidence that direct dispatch cannot meet throughput, backpressure, or reliability requirements. The coordinator may process targets in bounded sequential or concurrent groups while preserving per-runtime overlap protection. A Queue may be reconsidered only when an observed requirement justifies its additional operational and quota costs.

A refresh command is an explicit request for the target runtime to update itself; it is not a payload batch containing provider responses. Each runtime owns provider acquisition, validators, reconciliation, persistence, and publication. A coordinator dispatching a command must not claim that the refresh completed until the runtime reports its outcome.

## Readiness orchestration

Event readiness and Team readiness remain independently scoped Workflows where their discovery and coverage requirements differ. They inspect durable publication/source coverage and report which runtimes require refresh; they do not themselves dispatch provider refreshes. The polling coordinator owns all live refresh timing and dispatch, using the shared runtime command contract. Workflow execution records belong to System Records, not Discovery.

## Architectural boundaries

1. Discovery owns discovery data only.
2. System Records owns durable records about system operations, not canonical event/team state.
3. Runtime Durable Objects own canonical event/team state and per-runtime coordination.
4. Discovery and System Records may initially share one D1 database, but must have separate schemas, repository interfaces, and domain ownership.
5. KV is suitable for lightweight projections, not canonical state, transactional coordination, or authoritative operational history.
6. Cross-product operations are not assumed to be atomic. D1, KV, and Durable Object updates require explicit consistency and recovery strategies.
7. Persistent reads must remain side-effect-free. No hidden writes, TTL refreshes, lazy initialization, read-time migrations, counters, or unchanged-state rewrites.
8. Persistent mutations must be explicit, auditable, documented, and attributable to an operation and reason.
9. Storage workloads and daily usage must be budgeted independently for D1, KV, and Durable Objects.

## Rationale

The previous implementation placed unrelated responsibilities inside DiscoveryStore. This coupled discovery with workflow and runtime operations and caused unrelated operational writes to consume the same Durable Object storage quotas as runtime state.

Separating the domains:
- Isolates storage workloads and their respective quotas.
- Makes ownership and mutation paths easier to audit.
- Prevents operational recordkeeping from consuming runtime persistence capacity.
- Allows independent retention, indexing, and access policies.
- Keeps each repository focused on one responsibility.
- Keeps provider fetching and canonical reconciliation with the runtime that owns the data.

## Migration consequences

Before implementation:
- Inventory every existing DiscoveryStore key, record type, route, and caller.
- Classify each record as Discovery or System Records; do not migrate records based solely on their current key prefix or storage location.
- Identify any records that are actually runtime canonical state and keep them with the owning runtime.
- Design separate D1 schemas and repository interfaces for Discovery and System Records.
- Define retention policies for operational records and diagnostic logging.
- Define safe migration, cutover, rollback, and recovery behavior across D1, KV, and Durable Objects.
- Recalculate daily operation and storage budgets using the new ownership model.
- Remove obsolete DiscoveryStore responsibilities only after their replacements are verified.

This is an architecture decision, not authorization to deploy resources, change Cloudflare settings, or perform the data migration.

## Related decisions

- Only `events-this-week` is maintained as the weekly event candidate set; a separate `events-in-progress` list is not required.
- Event eligibility is evaluated by the dispatcher at dispatch time using event-local date boundaries.
- The weekly candidate list is refreshed every Monday at 16:00 UTC and can also be manually refreshed through the admin interface. The projection window rolls at that UTC boundary, remains the candidate set through the following Sunday in event-local time, and the polling coordinator re-evaluates lifecycle eligibility on every dispatch.
- Cloudflare does not provision isolated Workflow instances for Worker Previews. Keep the weekly projection Workflow binding in the top-level production configuration only; do not bind a Preview to the production Workflow. Manual weekly refresh is unavailable in branch Previews until an isolated non-production Workflow strategy exists.
- EventRuntime performs its own TBA resource fetching, reconciliation, delta generation, and persistence.
- Event and Team readiness remain separate Workflows.
- HTTP 304 responses are strict no-ops, and unchanged canonical state is not rewritten.
