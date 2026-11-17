# FieldView Architecture Migration Plan

**Status:** M1 source inventory complete; M2 repository foundation complete; M3 domain foundation in progress
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
| Canonical identity | TBA team, event, and match keys; TBA-first aggregates with field-specific provider enrichment |

These decisions are settled unless a concrete implementation constraint requires revisiting one.

## 2. Migration principles

1. **Keep the application usable throughout migration.** Each meaningful change should leave the branch buildable and should preserve existing product behavior unless that behavior is intentionally being redesigned.
2. **Move ownership, not just files.** A migration is complete when the new boundary owns the responsibility and old callers no longer bypass it.
3. **One authoritative owner per responsibility.** Temporary mirrors and comparison paths are acceptable, but two systems must not independently write the same authoritative state.
4. **Preserve provider data until FieldView normalization.** TBA and Statbotics payloads pass unchanged into FieldView normalization; every other provider's data passes through unchanged. No value may be implicitly renamed, converted, reinterpreted, defaulted, omitted, or overwritten. Any transformation requires explicit description and approval before implementation, and must have a specifically named, documented field in each forward-facing model.
5. **Frontend consumes FieldView domain objects.** Client code uses the canonical FieldView domain model and its ordinary serialized representation; it must not depend on provider clients, Redis, or Cloudflare implementation types.
6. **Keep the domain infrastructure-independent.** The domain may depend on provider packages for unchanged source field types, but neither domain nor provider packages may depend on React, Next.js, or Cloudflare. The domain is the canonical application model; do not duplicate it in a parallel DTO package.
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
  domain/                      # FieldView normalization and derived-data domain models
    src/
      normalization/            # Approved TBA and Statbotics transformations only
  providers/
    tba/
      src/
        generated/
        client/
        services/
        types/
      scripts/                 # TBA schema generation
    statbotics/
      src/
        generated/
        client/
        services/
        types/
      scripts/                 # Statbotics schema generation
    frc-colors/
      src/
        client/
        services/
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

- `packages/domain` may have type-only dependencies on provider packages for unchanged provider-sourced fields. It must not import provider clients or transport implementations. It has no runtime dependency on UI or infrastructure.
- The domain model is the shared application data model. HTTP and WebSocket boundaries serialize these objects directly; transport code must not introduce a second semantic model.
- The domain may import provider types for unchanged pass-through fields using type-only dependencies. Provider packages own their schemas and provider-specific implementation; the client receives serialized FieldView domain objects, not provider clients or acquisition code.
- The Worker may compose providers, domain services, analytics, storage, and Durable Objects.
- The web application should consume serialized FieldView domain objects and presentation-safe utilities, not provider clients or backend runtime modules. Provider implementations and infrastructure types remain outside the client.
- Analytics accepts normalized input data and has no hidden provider fetching or UI dependency.
- Each provider package owns its generated schemas, schema-generation tooling, clients, services, and provider-specific types.
- Provider-specific API implementation must not be split across the web application, domain package, or generic schema packages.
- Provider packages own generated schemas, API clients, services, provider-specific types, and generation tooling. They pass provider payloads unchanged into FieldView domain normalization. The domain owns first-class FieldView models, cross-source associations, and explicitly approved transformations.

## 4. Runtime responsibility model

| Responsibility | Default owner |
| --- | --- |
| HTTP routing and stateless request handling | Cloudflare Worker |
| TBA / Statbotics / FRC Colors API access | Provider adapters invoked by Workers |
| TBA and Statbotics normalization/correlation | FieldView domain layer, after unchanged provider payload receipt |
| Other provider payloads | Passed through unchanged |
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
- Consumers are migrated to the canonical FieldView domain model and its serialized representation.
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
- Establish npm workspaces and shared TypeScript/lint/test configuration around the relocated app. (The initial `apps/web` workspace is committed and locally validated.)
- Add CI for installation, lint, typecheck, tests, and build as each becomes available.

**Exit criteria**
- A clean checkout installs reproducibly.
- The Next.js application runs and builds from its workspace.
- CI validates the workspace.
- No provider or backend runtime dependency leaks into the web package through convenience imports.

**Status:** Complete. Architecture guidance, ADRs, README, and source inventory are in place. The Next.js app is relocated to `apps/web` and registered as the `@fieldview/web` npm workspace. A clean `npm ci` and workspace production build have been validated locally. The initial domain test harness is in place. GitHub Actions validates Next.js type generation, workspace typechecking, domain tests, and reports lint as non-blocking because of the pre-existing legacy baseline (62 errors, 35 warnings). By explicit project decision, CI does not run a production build or prerender pages; production builds remain the hosting platform's responsibility. This CI workflow is validation, not a deployable build artifact.

### M3 — Canonical domain foundation

**Status:** In progress. TBA and Statbotics provider workspaces own their generated schemas, provider type aliases, and generation scripts. The first-class FieldView domain model is documented in `docs/domain/FIELDVIEW-DATA-MODEL-V1.md`, using Archimedes SF13 as its reference case. Initial types now exist for team, season, event, event-team, match, playoff-alliance, provenance, and analytics concepts. `FieldViewMatch` retains the exact TBA match type and adds explicitly typed Statbotics associations, independent predictions, analysis, playoff associations, and evidence-bearing flags. An initial pure `normalizeFieldViewMatch` composition boundary now associates the independent TBA match, TBA event prediction, TBA event OPR, and Statbotics match resources. It preserves the original TBA match fields, keeps predictions independent, uses only explicitly supplied cross-provider team identity associations, and associates EPA/OPR values without mutating source records. Archimedes SF13 fixture tests cover source preservation, independent predictions, roster-order associations, and the absence of inferred Statbotics IDs. The normalization implementation passed workspace typechecking and domain tests in CI; the new transport round-trip tests are awaiting CI validation. Remaining M3 work: complete and review the canonical domain objects, verify that their public data shapes serialize and round-trip without semantic loss, and add fixture-driven serialization tests. There will be no separate DTO package or duplicated client model; the domain objects themselves are the application data model.

**Work**
- Define canonical models including FieldViewTeam, FieldViewTeamSeason, FieldViewEvent, FieldViewEventTeam, FieldViewMatch, FieldViewPlayoffAlliance, and analytics result types.
- Finalize the canonical FieldView domain objects that are shared by backend and client.
- Specify missing vs null vs explicit clear semantics, provenance, freshness, and partial-failure representation.
- Add fixture-driven domain and serialization tests. Validate transport serialization of the domain objects rather than defining a second schema.

**Exit criteria**
- Domain builds independently of Next.js and Cloudflare, with provider workspace packages available only for unchanged source field types.
- Canonical domain objects serialize and deserialize through the selected transport without changing their defined values or missing/null semantics.
- The frontend consumes FieldView domain objects and does not import provider clients or infrastructure implementations.

### M4 — Provider adapter migration

**Work**
- Introduce isolated TBA, Statbotics, and FRC Colors adapters.
- Keep raw provider schemas, API details, and provider-specific clients inside their respective packages. The domain may use provider types for unchanged source fields; clients consume the FieldView domain shape and never provider acquisition implementations.
- Pass TBA and Statbotics payloads unchanged into FieldView normalization. Pass every other provider payload through unchanged.
- Implement only transformations that have been explicitly described and approved; represent each result in a specifically named, documented FieldView field.
- Define per-field source precedence and internal provenance/freshness.
- Preserve valid prior data on failed or partial acquisition; distinguish omitted fields from authoritative clears.
- Move TBA and Statbotics OpenAPI generation into their respective provider packages.
- Keep generated output, generator scripts, and provider integration code together.
- Remove frontend dependencies on provider clients and provider-specific acquisition logic; frontend data is supplied as serialized FieldView domain objects.

**Exit criteria**
- Provider fixtures cover normal, partial, stale, malformed, and failed responses.
- Provider adapters expose provider payloads without changing their values.
- Any approved FieldView normalization outputs are explicit, documented, and separately named; unapproved transformations do not exist.
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
- Consume serialized FieldView domain objects directly.
- Replace browser-owned provider acquisition with backend subscriptions.
- Preserve useful behavior and visual identity while removing obsolete architecture.
- Keep remote actions routed through the same authoritative controller path as local actions.

**Exit criteria**
- No frontend provider schema imports or direct provider requests remain.
- Views render serialized FieldView domain snapshots and do not own shared acquisition.
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
- TBA provider integration and unchanged payload handoff into FieldView normalization;
- FieldViewEvent and FieldViewEventTeam domain models;
- EventRuntime ownership and publication;
- serialized FieldView domain objects;
- a real Next.js consumer.

It avoids making the first migration depend on the most complicated analytics workflows. Match reconciliation should follow once the event/team ownership and publication path is proven.

## 8. Historical audit disposition

The existing `docs/APPLICATION-AUDIT.md` contains 104 findings from the legacy implementation. Treat it as evidence and a source of test scenarios, not as a backlog to mechanically fix in the old architecture.

| Finding family | Migration treatment |
| --- | --- |
| Provider correctness and normalization | Preserve source payloads; implement only explicitly approved transformations in FieldView normalization and named domain fields |
| Provider-shaped client state | Replace with canonical FieldView domain objects; remove direct provider acquisition from clients |
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

1. Complete the remaining M2 checks: confirm the post-relocation import graph, add CI, and establish a test harness after identifying which build-time routes require provider/Redis configuration. Never put production secrets into CI.
2. Keep the migration branch deployment pause and current Vercel root directory unchanged; do not enable deployments or change production settings as part of workspace work.
3. Continue M3 by completing the canonical domain model, verifying direct JSON transport serialization and round-trip behavior, and adding fixture-driven tests before migrating application consumers.
4. Resolve the open EventRuntime, event-team refresh, publication, and storage decisions before implementing backend state ownership.

**Current implementation status:** The Next.js application is relocated to `apps/web` and registered as the `@fieldview/web` npm workspace. The root package manifest and lockfile remain authoritative. TBA and Statbotics schema/type-generation files have moved into `packages/providers`; provider clients and services have not yet been migrated. The first FieldView domain-model baseline is documented in `docs/domain/FIELDVIEW-DATA-MODEL-V1.md`; initial domain types and match normalization are implemented, and direct transport serialization validation is now covered by fixture tests. The workspace lockfile has been refreshed and pushed. The legacy Redis/SharedWorker/Vercel data path remains. No Cloudflare Worker, Durable Object, or production infrastructure is claimed to exist.
