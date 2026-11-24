# ADR-0017: One FieldView Worker per environment

> **Scope clarification (2026-11-24):** The one-Worker-per-environment deployment decision remains accepted. The storage ownership and runtime polling provisions in this ADR are superseded by [`decisions/2026-11-24-storage-and-polling-ownership.md`](decisions/2026-11-24-storage-and-polling-ownership.md). DiscoveryStore is not the target operational database; System Records do not belong in Discovery; EventRuntime and TeamRuntime share one runtime abstraction and use coordinator-owned direct refresh dispatch. The current `DiscoveryStore` Durable Object binding is transitional until Discovery and System Records D1 repositories are implemented and cut over.

- **Status:** Accepted
- **Date:** 2026-11-22

FieldView will deploy exactly one Cloudflare Worker per environment: `fieldview-preprod` and `fieldview-production`. Each deployment hosts the HTTP API, webhook ingress, EventRuntime, TeamRuntime, Multiplexer, DiscoveryStore, and the DailyEventReadinessWorkflow, CoverageAuditWorkflow, and RuntimeAdminWorkflow classes.

This is a deployment-boundary decision, not a monolith decision. Runtime, Jobs orchestration, provider adapters, domain logic, analytics, and HTTP routing remain separate modules with explicit responsibilities. EventRuntime and TeamRuntime remain independent Durable Object consistency and refresh boundaries. A single Worker does not mean a single Durable Object.

Runtime and Jobs communicate through internal module interfaces and direct Durable Object namespace access. No Runtime-to-Jobs, Jobs-to-Runtime, or self-service bindings are used.

Preproduction and Production have independent Worker configurations, Durable Object namespaces, Workflow bindings and instances, secrets, variables, and data. Preproduction is the full integration environment; it must not share state or credentials with Production.

## Retained responsibilities

- **Polling coordinator:** one stateless module in the consolidated Worker selects eligible event/team runtime targets, applies lifecycle rules, bounds concurrency, prevents overlapping refreshes, and dispatches direct refresh commands. It never fetches provider resources or constructs canonical deltas. A Queue is optional only if measured requirements justify one.
- **EventRuntime and TeamRuntime:** two scopes of the same runtime abstraction. Both accept the same explicit refresh command and own their scope-specific provider acquisition, validators, reconciliation, canonical state, retries, and publication. They do not dispatch work to each other.
- **Multiplexer:** realtime subscription and publication coordination only.
- **Discovery:** D1-backed discovery directories, current-season metadata, and the weekly `events-this-week` candidate set. The current DiscoveryStore Durable Object is a transitional implementation and must be migrated to the Discovery repository before it is retired.
- **System Records:** D1-backed Workflow execution records/progress/outcomes, runtime registration, administrative actions, and operational history. This is a separate repository/schema from Discovery. The current DiscoveryStore-held operational records are transitional and must be inventoried and migrated by responsibility.
- **Workflows:** durable cross-runtime/system-wide orchestration for discovery readiness, coverage, seeding, and admin operations. They inspect readiness and dispatch explicit runtime commands when their operation requires it; they do not perform entity provider I/O or duplicate entity-local queues.
- **Provider packages:** provider transport, schemas, and provider-specific request policy; called by the owning runtime or Discovery repository, never directly by Workflow code.
- **Domain and analytics packages:** canonical FieldView models and provider/UI/infrastructure-independent calculations.

## Consequences

Benefits are one deployment and configuration per environment, no reciprocal service-binding dependencies, and simpler release coordination. Tradeoffs are a shared deployment/failure boundary and the need to enforce public/internal route authorization explicitly.

## Implementation requirements

1. Consolidate Runtime and Jobs entrypoints into one Worker script while preserving separate modules and contracts.
2. Replace service-binding calls with internal functions or direct Durable Object namespace calls; do not use self-service bindings.
3. Export EventRuntime, TeamRuntime, and Multiplexer Durable Object classes, plus all deployed Workflow classes, from each environment's Worker configuration. DiscoveryStore remains exported only while the transitional D1 migration requires it.
4. Keep Durable Object class names and SQLite migration history explicit. Current experimental resources are disposable, so establish clean namespaces under the new Worker names rather than attempting cross-Worker class migration.
5. Preserve asynchronous submit/observe/execute for long-running admin operations.
6. Move system-wide TBA season/event/team directory acquisition into the D1-backed Discovery repository. Move Workflow/runtime registration and admin history into the separate System Records repository. Workflows may invoke discovery operations and dispatch bounded runtime commands, but must not make entity provider requests. Keep entity-scoped provider acquisition in EventRuntime and TeamRuntime.
7. Validate build, typecheck, tests, local Worker behavior, Wrangler configuration, and Preproduction smoke tests before creating or changing Production resources.
8. Do not delete experimental Cloudflare resources until consolidated source and configuration pass repository validation. Do not deploy or modify Cloudflare resources as part of this repository change.

Rollback before real production data exists is a source/configuration change and clean redeployment. After Production begins storing canonical data, any topology change requires a separately reviewed Durable Object and Workflow migration plan.
