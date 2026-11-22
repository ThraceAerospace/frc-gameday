# ADR-0017: One FieldView Worker per environment

- **Status:** Accepted
- **Date:** 2026-11-22

FieldView will deploy exactly one Cloudflare Worker per environment: `fieldview-preprod` and `fieldview-production`. Each deployment hosts the HTTP API, webhook ingress, EventRuntime, TeamRuntime, Multiplexer, DiscoveryStore, and the DailyEventReadinessWorkflow, CoverageAuditWorkflow, and RuntimeAdminWorkflow classes.

This is a deployment-boundary decision, not a monolith decision. Runtime, Jobs orchestration, provider adapters, domain logic, analytics, and HTTP routing remain separate modules with explicit responsibilities. EventRuntime and TeamRuntime remain independent Durable Object consistency and refresh boundaries. A single Worker does not mean a single Durable Object.

Runtime and Jobs communicate through internal module interfaces and direct Durable Object namespace access. No Runtime-to-Jobs, Jobs-to-Runtime, or self-service bindings are used.

Preproduction and Production have independent Worker configurations, Durable Object namespaces, Workflow bindings and instances, secrets, variables, and data. Preproduction is the full integration environment; it must not share state or credentials with Production.

## Retained responsibilities

- **EventRuntime:** event-scoped provider acquisition, durable local work, reconciliation, persistence, and event analytics.
- **TeamRuntime:** team-scoped provider acquisition, durable local work, reconciliation, persistence, and team analytics.
- **Multiplexer:** realtime subscription and publication only.
- **DiscoveryStore:** discovery catalog, runtime inventory, and durable Workflow progress.
- **Workflows:** durable cross-runtime/system-wide orchestration. They dispatch commands and inspect readiness; they do not become provider proxies or duplicate entity-local queues.
- **Provider packages:** provider transport, schemas, retries, and provider-specific request policy.
- **Domain and analytics packages:** canonical FieldView models and provider/UI/infrastructure-independent calculations.

## Consequences

Benefits are one deployment and configuration per environment, no reciprocal service-binding dependencies, and simpler release coordination. Tradeoffs are a shared deployment/failure boundary and the need to enforce public/internal route authorization explicitly.

## Implementation requirements

1. Consolidate Runtime and Jobs entrypoints into one Worker script while preserving separate modules and contracts.
2. Replace service-binding calls with internal functions or direct Durable Object namespace calls; do not use self-service bindings.
3. Export all four Durable Object classes and all three Workflow classes from each environment's Worker configuration.
4. Keep Durable Object class names and SQLite migration history explicit. Current experimental resources are disposable, so establish clean namespaces under the new Worker names rather than attempting cross-Worker class migration.
5. Preserve asynchronous submit/observe/execute for long-running admin operations.
6. Audit Workflow code for provider I/O that conflicts with the rule that EventRuntime and TeamRuntime own provider acquisition.
7. Validate build, typecheck, tests, local Worker behavior, Wrangler configuration, and Preproduction smoke tests before creating or changing Production resources.
8. Do not delete experimental Cloudflare resources until consolidated source and configuration pass repository validation. Do not deploy or modify Cloudflare resources as part of this repository change.

Rollback before real production data exists is a source/configuration change and clean redeployment. After Production begins storing canonical data, any topology change requires a separately reviewed Durable Object and Workflow migration plan.
