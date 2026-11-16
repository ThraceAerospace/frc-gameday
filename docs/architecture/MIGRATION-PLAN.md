# FieldView Architecture Migration Plan

**Status:** M1 source inventory completed; M2 repository foundation in progress (Next.js app relocated to `apps/web`; post-relocation validation and npm workspace conversion remain)
**Target branch:** `fieldview-architecture-migration`
**Strategy:** Incremental migration
**Last updated:** 2026-11-16

This document is the working migration plan for evolving the existing FieldView application into the target architecture. It is deliberately separate from the historical application audit: audit findings describe observed problems in the old implementation, while this document describes the destination and the order in which responsibilities will move.

## 1. Confirmed decisions

| Area | Decision |
| --- | --- |
| Repository tooling | npm workspaces |
| Frontend | Retain Next.js |
| Migration strategy | Incremental, with old and new implementations coexisting temporarily |
| Backend runtime | Hybrid Cloudflare Workers and Durable Objects |

These decisions are settled unless a concrete implementation constraint requires revisiting one.

## 2. Migration principles

1. **Keep the application usable throughout migration.** Each meaningful change should leave the branch buildable and should preserve existing product behavior unless that behavior is intentionally being redesigned.
2. **Move ownership, not just files.** A migration is complete when the new boundary owns the responsibility and old callers no longer bypass it.
3. **One authoritative owner per responsibility.** Temporary mirrors and comparison paths are acceptable, but two systems must not independently write the same authoritative state.
4. **Normalize at provider boundaries.** Provider schemas, identifiers, status values, and response quirks remain inside provider adapters.
5. **Frontend consumes FieldView contracts.** Client code must not depend on TBA, Statbotics, Redis, or Cloudflare implementation types.
6. **Keep domain models independent.** Domain and contract packages must not depend on React, Next.js, Cloudflare, or provider packages.
7. **Prefer the smallest sufficient runtime.** Workers are the default execution environment. Durable Objects are introduced where persistent state, coordination, ordering, or realtime subscription ownership requires them.
8. **Keep analytics declarative and generic.** Definitions describe metrics; a small engine executes registered operations. No arbitrary expression evaluation.
9. **Preserve event-timezone presentation.** All event dates and times are displayed in the relevant event's IANA timezone.
10. **Validate before cutover.** Production traffic is not moved until behavior, data, failure recovery, and rollback have been validated.

## 3. Target repository boundaries

The intended structure is:

```text
apps/
  web/                         # Next.js UI and presentation
workers/
  backend/                     # Cloudflare Worker entrypoints and runtime wiring
packages/
  contracts/                   # Versioned, serializable client DTOs
  domain/                      # Canonical FieldView domain models and rules
  providers/
    tba/
      src/
        generated/
        client/
        services/
        normalization/
        types/
      scripts/                 # TBA schema generation
    statbotics/
      src/
        generated/
        client/
        services/
        normalization/
        types/
      scripts/                 # Statbotics schema generation
    frc-colors/
      src/
        client/
        services/
        normalization/
        types/
  analytics/
    definitions/               # Declarative metric definitions
    engine/                    # Generic operation execution
    results/                   # Standardized analytics result types
  shared/                      # Small, genuinely cross-package utilities
docs/
  architecture/
  decisions/
  domain/
  analytics/
  development/
```

This is a destination, not a mandate to move every existing file immediately. Reusable UI components remain in `apps/web` until a second real consumer justifies a separate UI package.

### Dependency direction

- `packages/domain` has no runtime dependency on providers, contracts, UI, or infrastructure.
- `packages/contracts` describes serialized boundaries using domain-safe types; it does not import provider models.
- Provider packages may depend on domain types to produce normalized objects, but domain packages never depend on providers.
- The Worker may compose providers, domain services, analytics, storage, and Durable Objects.
- The web application consumes contracts and presentation-safe utilities; it does not import provider packages or backend runtime modules.
- Analytics accepts normalized input data and has no hidden provider fetching or UI dependency.
- Each provider package owns its complete integration, including generated schemas, schema-generation tooling, clients, services, validation, and normalization.
- Provider-specific implementation must not be split across the web application, domain package, or generic schema packages.
- Each provider package translates external data into canonical FieldView domain values. Raw provider types remain internal to that package.

## 4. Runtime responsibility model

| Responsibility | Default owner |
| --- | --- |
| HTTP routing and stateless request handling | Cloudflare Worker |
| TBA / Statbotics / FRC Colors API access | Provider adapters invoked by Workers |
| Provider validation and normalization | Provider adapters |
| Scheduled refresh triggers | Worker Cron Triggers |
| Authoritative event state and reconciliation | EventRuntime Durable Object |
| Event-scoped persistent coordination | EventRuntime Durable Object |
| Live event subscriptions and publication | Durable Object / Worker boundary |
| Pure analytics calculations | Analytics package executed by Worker |
| Durable analytics job coordination | Add only if demonstrated necessary |
| Team-level persistent runtime | Defer until ownership and access patterns justify it |

The first likely Durable Object is one `EventRuntime` per event. It owns the event's authoritative shared lifecycle and may contain modular internal state components. Internal modules do not create independent concurrency or independent Durable Object lifecycles.

Do not create a Durable Object for every domain interface. A `FieldViewTeam` is a domain object, not automatically a `TeamRuntime`. Add separate team or analytics runtimes only when their consistency, lifecycle, or scaling requirements justify them.

## 5. Incremental migration model

The legacy application remains operational while individual responsibilities move to the new implementation.

- A responsibility is first mapped and given a target owner.
- The new implementation is built behind a clear boundary.
- During validation, outputs may be compared against the old implementation.
- A single owner is selected for writes and authoritative publication.
- Consumers are migrated to the new contract.
- The old implementation is retired only after all callers and operational dependencies have moved.

Do not build a permanent dual-write system. If temporary mirroring is needed for validation, it must be read-only from the comparison side, observable, and explicitly time-limited.

## 6. Migration phases and exit criteria

### M1 — Audit and migration mapping

**Work**
- Verify the current branch and repository baseline.
- Classify existing capabilities and audit findings as preserve, migrate, redesign, retire, or investigate.
- Map current application routes, API handlers, provider clients, state owners, analytics flows, and remote-session behavior to target boundaries.
- Identify cutover dependencies and risks.

**Exit criteria**
- Every major existing responsibility has a proposed target owner.
- Unresolved design questions are explicitly recorded.
- No implementation work is based solely on an unverified historical audit finding.

**Status:** Complete. The source inventory, 22 API handlers, environment-variable names and Vercel scopes (values withheld), and source import graph have been inspected. The Next.js application has since been relocated to `apps/web`; its post-relocation build validation remains part of M2.

### M2 — Architecture and repository foundation

**Work**
- Replace contradictory legacy instructions with migration-aware repository guidance while retaining useful product invariants.
- Establish architecture decision records and package dependency rules.
- Move the existing Next.js application into `apps/web` with behavior preserved. (Committed; post-relocation validation remains.)
- Introduce npm workspaces and shared TypeScript/lint/test configuration around the relocated app.
- Add CI for installation, lint, typecheck, tests, and build as each becomes available.

**Exit criteria**
- A clean checkout installs reproducibly.
- The Next.js application runs and builds from its workspace.
- CI validates the workspace.
- No provider or backend runtime dependency leaks into the web package through convenience imports.

**Status:** In progress. Architecture guidance, ADRs, README, and source inventory are in place. The Next.js app has been relocated to `apps/web`. The root package manifest and lockfile remain; npm workspaces, CI, and the initial test harness are not yet established.

### M3 — Domain and contract foundation

**Work**
- Define canonical models including FieldViewTeam, FieldViewTeamSeason, FieldViewEvent, FieldViewEventTeam, FieldViewMatch, FieldViewPlayoffAlliance, and analytics result types.
- Define versioned serializable client DTOs.
- Specify missing vs null vs explicit clear semantics, provenance, freshness, and partial-failure representation.
- Add schema validation and fixture-driven contract tests.

**Exit criteria**
- Domain and contracts build independently of Next.js, Cloudflare, and provider packages.
- Provider-shaped objects cannot be published directly as client contracts.
- Contract compatibility and validation tests pass.

### M4 — Provider adapter migration

**Work**
- Introduce isolated TBA, Statbotics, and FRC Colors adapters.
- Keep raw provider types and API details inside their respective packages.
- Normalize provider responses into FieldView-owned domain data.
- Define per-field source precedence and internal provenance/freshness.
- Preserve valid prior data on failed or partial acquisition; distinguish omitted fields from authoritative clears.
- Move TBA and Statbotics OpenAPI generation into their respective provider packages.
- Keep generated output, generator scripts, and provider integration code together.
- Remove frontend dependencies on provider-generated types as consumers migrate to FieldView contracts.

**Exit criteria**
- Provider fixtures cover normal, partial, stale, malformed, and failed responses.
- Provider adapters return normalized FieldView data.
- Consumers do not import provider-generated types.

### M5 — Cloudflare backend and event runtime

**Work**
- Establish Worker entrypoints, environment bindings, deployment configuration, and local development.
- Implement the first EventRuntime Durable Object.
- Establish authoritative event-state ownership, persistence, reconciliation, and versioned publication.
- Implement webhook invalidation and scheduled safety refreshes.
- Define WebSocket/subscription authentication, lifecycle, and reconnect behavior.

**Exit criteria**
- One event has one authoritative runtime owner.
- Concurrent refreshes cannot publish stale results over newer data.
- Failed refreshes do not erase valid state.
- Restart/recovery and reconnect behavior are tested.
- The old backend remains available for unaffected responsibilities.

### M6 — Analytics engine migration

**Work**
- Define a small registered operation vocabulary.
- Implement a generic engine for input resolution, validation, operation execution, and standardized output.
- Express metrics as versioned declarative definitions.
- Support both single-entity and collection/event-wide calculations.
- Keep calculation, interpretation, summary text, and presentation separate.

**Exit criteria**
- Definitions contain no arbitrary executable code or provider fetches.
- Historical fixtures validate migrated outputs.
- Missing-data and sample-size behavior is explicit.
- Event-wide rankings and comparisons report their actual eligible population.

### M7 — Frontend and product-surface migration

**Work**
- Migrate events, teams, gameday, insights, and remote surfaces incrementally.
- Consume FieldView contracts exclusively.
- Replace browser-owned provider acquisition with backend subscriptions.
- Preserve useful behavior and visual identity while removing obsolete architecture.
- Keep remote actions routed through the same authoritative controller path as local actions.

**Exit criteria**
- No frontend provider schema imports or direct provider requests remain.
- Views render contract snapshots and do not own shared acquisition.
- Realtime, remote-session, and event-timezone invariants pass integration tests.

### M8 — Validation and production cutover

**Work**
- Compare old and new outputs over representative historical and live events.
- Test provider outages, partial data, stale data, webhook duplication, out-of-order updates, concurrent requests, reconnects, and runtime restarts.
- Validate analytics parity and intentional differences.
- Establish deployment, observability, rollback, and data-retention procedures.
- Move production traffic only after explicit acceptance.

**Exit criteria**
- Critical product behavior and data correctness are validated.
- Failure recovery and rollback are rehearsed.
- No unresolved critical migration blockers remain.
- Production cutover is explicitly approved.

## 7. First vertical migration candidate

The recommended first end-to-end slice is **event metadata and event teams**.

It exercises:
- TBA provider integration and normalization;
- FieldViewEvent and FieldViewEventTeam domain models;
- EventRuntime ownership and publication;
- versioned client contracts;
- a real Next.js consumer.

It avoids making the first migration depend on the most complicated analytics workflows. Match reconciliation should follow once the event/team ownership and publication path is proven.

## 8. Historical audit disposition

The existing `docs/APPLICATION-AUDIT.md` contains 104 findings from the legacy implementation. Treat it as evidence and a source of test scenarios, not as a backlog to mechanically fix in the old architecture.

| Finding family | Migration treatment |
| --- | --- |
| Provider correctness and normalization | Address in provider adapters and domain contracts |
| Provider-shaped client state | Eliminate through contract migration |
| Redis / realtime cache coherence | Reassess against EventRuntime ownership and reconciliation |
| Browser SharedWorker acquisition ownership | Replace with backend-authoritative state and subscriptions |
| Analytics orchestration and dashboard calculations | Rebuild around declarative definitions and a generic engine |
| Persistence, concurrency, and job schema | Address in runtime/storage design |
| Remote-session/controller behavior | Preserve product invariants; migrate transport independently |
| Missing tests and CI | Establish in repository foundation and add tests alongside each slice |

Every finding should be revalidated before implementation. Some will disappear because the old mechanism is retired; others will become acceptance tests for the replacement.

## 9. Initial risk register

| Risk | Mitigation |
| --- | --- |
| Two systems write the same event state | Assign one authoritative owner per migration slice; prohibit permanent dual writes |
| Moving directories breaks deployment/configuration | Relocate the Next.js app as a dedicated foundation change with build parity |
| Legacy instructions contradict target architecture | Update agent guidance before implementation migration |
| Provider data is lost or incorrectly cleared | Explicit merge semantics, provenance, fixtures, and failure tests |
| Durable Objects become too numerous or tightly coupled | Start with EventRuntime; add runtimes only for clear lifecycle/coordination boundaries |
| Analytics migration changes historical interpretations silently | Version metric definitions and compare against historical fixtures |
| Frontend retains hidden provider dependencies | Enforce package boundaries and inspect dependency graph/imports |
| Production migration disrupts live events | Keep legacy path available until validated cutover and rollback |

## 10. Immediate next actions

1. Complete post-relocation import-graph, clean-install, typecheck, and production-build verification from a local checkout. The source inventory is not a substitute for executing the actual workspace.
2. Inspect the current Vercel build/install/root-directory settings and deployment environment scopes as needed; variable names/scopes were inspected with decryption disabled and recorded in the migration inventory. Keep the migration branch deployment pause and current root directory unchanged until local workspace validation is complete.
3. Introduce npm workspaces in a small, behavior-preserving change. Keep the root lockfile authoritative, retain the current root install layout initially, and verify that `apps/web` can build from the workspace root before changing Vercel settings.
4. Add CI and the initial test harness only after determining which build-time routes require provider/Redis configuration; never put production secrets into CI.
5. Resolve the open EventRuntime, event-team refresh, publication, and storage decisions before implementing backend state ownership.

**Current implementation status:** The Next.js application has been relocated from the repository root to `apps/web`. The root package manifest and lockfile remain in place; npm workspaces have not yet been enabled. The legacy Redis/SharedWorker/Vercel data path remains. No Cloudflare Worker, Durable Object, provider workspace, or production infrastructure is claimed to exist.
