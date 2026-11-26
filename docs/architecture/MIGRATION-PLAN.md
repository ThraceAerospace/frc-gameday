# FieldView Architecture Migration Plan

**Status:** M1 source inventory complete; M2 repository foundation complete; M3 domain foundation complete; M4 provider/runtime boundary in progress; M5 runtime prototype transitioning to the unified direct-refresh model; M6 analytics migration in progress; M7 canonical frontend migration in progress; M8 cutover validation pending
**Target branch:** `fieldview-architecture-migration`
**Strategy:** Owner-approved retire-first, rebuild-cleanly migration
**Last updated:** 2026-11-25

This document is the working migration plan for evolving FieldView into the target architecture. The owner has explicitly approved temporary functionality loss on fieldview-architecture-migration so obsolete implementations can be retired and rebuilt against the target architecture. Preserve canonical contracts, useful domain/provider/analytics work, architectural decisions, and platform-required migration history; do not preserve obsolete compatibility paths solely to keep the old application functioning. The retirement classifications are in docs/architecture/RETIREMENT-AUDIT.md. This does not authorize merging to main, production deployment, or deletion/reconfiguration of deployed infrastructure.



## 2026-11-25 storage resource alignment

The storage resources are provisioned and their bindings are declared in `workers/fieldview/wrangler.toml`:

| Binding | Production | Branch / pull-request Previews |
| --- | --- | --- |
| `DB` | `fieldview-d1-prod` — `bd7852b3-7814-4c3f-9ce8-f1c244524843` | `fieldview-d1-test` — `6862b62b-73a0-43a5-8b2f-5ccd1e8bfc7e` |
| `KV_BINDING` | `fieldview-kv-prod` — `c067dfcaa3a345b0b43f035a992b4b30` | `fieldview-kv-test` — `19ef5d5221654ab4bac0c8118c35ad8b` |

Discovery and System Records remain separate logical ownership domains and repository interfaces, backed by exactly two generic JSON record tables within each environment's physical D1 database. All branch Previews currently share the test D1 database; it is isolated from Production but not from other Preview branches.

Production and Preview use separate KV namespaces. Both may independently hold FieldView-managed, non-authoritative projections derived from the same upstream TBA facts. KV remains mutable and eventually consistent, but Preview writes/deletes are isolated from Production. The two namespaces are not automatically synchronized; each environment may independently refresh its own projection.

An initial D1 schema is defined in `workers/fieldview/migrations/0001_initial.sql`, with `migrations_dir = "migrations"` configured for production and Preview. It contains exactly two generic JSON record tables: `discovery_records` and `system_records`. The in-process `DiscoveryService` now owns TBA season/directory acquisition and publication logic, using a D1-backed record adapter; Worker routes and Workflows call it directly. Separate `DiscoveryRecordsRepository` and `SystemRecordsRepository` implementations route records to their respective tables, with equality-guarded writes. The former `DiscoveryStore` Durable Object, binding, and RPC hop have been removed from the branch. Service and repository tests have been moved to the new implementation. The D1 migration has not been applied to either Cloudflare database, no Worker has been deployed, and no existing records need importing because the old Durable Object was never deployed or populated. Local test execution and remaining cutover validation are still required.

## 2026-11-24 architecture realignment

The accepted storage and polling decision in `docs/architecture/decisions/2026-11-24-storage-and-polling-ownership.md` supersedes earlier local-queue/alarm polling assumptions in this plan. EventRuntime and TeamRuntime are the same runtime abstraction at different scopes. Explicit refresh commands execute provider acquisition inside the target runtime. Neither runtime currently defines an `alarm()` handler or calls `setAlarm()` / `deleteAlarm()`; their `rearm()` and local scheduling helpers are no-ops. The source audit confirms there is no active DO alarm lifecycle. Readiness endpoints are inspection-only, and TeamRuntime and EventRuntime accept explicit scope-limited refresh commands. A bounded direct-dispatch helper and central polling coordinator are present. The coordinator now selects active events only and forwards exact stale resource lists, including Statbotics event matches. This is an in-progress transition, not a completed polling cutover: per-run rotating limits now cap event candidates at 8 per five-minute run, team readiness candidates at 50 per daily run, and TeamRuntime refresh commands at 20 per daily run. Account-wide provider/write budgets, the canonical weekly projection, changed-match team targeting, storage split, and full mutation audit remain outstanding. No Worker deployment, schema migration, or runtime cutover occurred. The owner provisioned separate production/test D1 databases and separate production/test KV namespaces; their bindings are now declared in the single Wrangler configuration.

Direct refresh now uses one shared EventRuntime/TeamRuntime command contract. EventRuntime and TeamRuntime no longer arm recurring polling alarms; readiness is inspection-only and acquisition occurs only after explicit refresh commands. The central coordinator now selects active events only, sends EventRuntime the exact stale endpoint list (including Statbotics as an owned resource), and sends TeamRuntime the exact stale resource list. An invalid publication with no individually stale resource still triggers a full owner-local rebuild. Direct 304 responses do not mutate endpoint state or publish unchanged snapshots. Accepted 200 responses advance canonical endpoint revisions only when normalized data changes; validator revisions remain separate. Most public reads are inspection-only, but the source audit found two EventRuntime exceptions (first-use identity binding and conditional legacy publication sanitization) and a repeatable TeamRuntime season-analytics cache write on GET. These are documented follow-up fixes.

### Remaining realignment work

1. Validate the canonical `events-this-week` implementation added on this branch: Monday 16:00 UTC publication, candidate retention through the event-local Sunday window, manual admin refresh, and dispatch-time event-local lifecycle evaluation by the polling coordinator. Run the full local test suite and verify the Workflow schedule/binding behavior before any deployment. Branch Preview limitation is documented in `decisions/2026-11-24-storage-and-polling-ownership.md`.
2. Derive affected team keys from changed event match representations/alliances and dispatch only those TeamRuntimes. The current coordinator endpoint accepts up to 12 caller-supplied team keys but does not yet derive them. Preserve one explicit refresh command per runtime and bounded direct concurrency; do not add a Queue by default.
3. Move cross-runtime analytics/input orchestration out of EventRuntime/TeamRuntime direct RPC paths where it represents cross-runtime work. Some EventRuntime-to-TeamRuntime analytics calls still exist. Keep each runtime authoritative for its own calculation and persisted output.
4. Validate the D1-backed Discovery and System Records repositories and direct `DiscoveryService` cutover against `workers/fieldview/migrations/0001_initial.sql`. Run the full local test suite and Worker typecheck, then address any failures. The source-level DO audit in `docs/architecture/DO-WRITE-AUDIT-2026-11-25.md` is a pre-cutover baseline; telemetry-backed physical write counts, billing semantics, and observed daily budgets remain open. No DiscoveryStore records need importing.
5. Remove inert per-runtime polling queue/task structures after the source audit. Current scheduling/enqueue/cancel/rearm methods are no-ops and no alarm handler exists; remove diagnostic-only task-key readers when no longer needed. Required work belongs to coordinator-owned explicit refresh commands or deliberately initiated Workflows. Do not restore a continuously armed runtime scheduler.
6. Fix the confirmed read-side-effect/write-amplification findings, complete strict 304 no-op and restart/recovery validation, and obtain Cloudflare telemetry for a real account-wide workload budget. Validate with repository CI before any deployment.

## 1. Confirmed decisions

| Area | Decision |
| --- | --- |
| Repository tooling | npm workspaces |
| Frontend | Retain Next.js |
| Migration strategy | Owner-approved retire-first/rebuild-cleanly; temporary functionality loss on the migration branch is acceptable |
| Backend runtime | Hybrid Cloudflare Workers and Durable Objects |
| Canonical identity | TBA team, event, and match keys; TBA-first aggregates with field-specific provider enrichment |
| Weekly event discovery | Publish one `events-this-week` candidate set on Monday, valid through Sunday, using inclusive date-range overlap and each event's IANA timezone. Admins can manually rebuild the projection for postponements. This candidate set is discovery input only; the polling coordinator evaluates active lifecycle eligibility at dispatch time (2026-11-24 decision) |
| TBA webhook routing | Worker ingress validates and scope-routes each original webhook directly to EventRuntime and affected TeamRuntimes; no EventRuntime relay or per-webhook TaskScheduler registration (ADR-0012) |

These decisions are settled unless a concrete implementation constraint requires revisiting one.

## 2. Migration principles

1. **Build the target architecture, not compatibility for its own sake.** Temporary branch functionality loss is acceptable. Retire obsolete implementations when ownership has moved or when the outage is intentional; preserve canonical contracts, useful product behavior, and required platform migration history. Keep focused changes testable, but a fully working application is not a prerequisite for every cleanup step.
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
  fieldview/                   # Single Cloudflare Worker entrypoint, event/team Durable Objects, and Workflows
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
| Scheduled refresh triggers | One polling coordinator in the consolidated FieldView Worker evaluates event lifecycle and directly dispatches bounded refresh commands to eligible EventRuntime and affected TeamRuntime instances. Runtime instances own provider acquisition, validators, reconciliation, persistence, and publication; no per-runtime polling queue/alarm is the default. |
| Authoritative event state and reconciliation | EventRuntime Durable Object |
| Event-scoped persistent coordination | EventRuntime Durable Object |
| Live event subscriptions and publication | Durable Object / Worker boundary |
| Pure analytics calculations | Analytics package executed by Worker |
| Durable analytics job coordination | The coordinator or a scoped Workflow dispatches analytics work; EventRuntime owns event-wide analytics and TeamRuntime owns team/team-event analytics. |
| Team-level persistent runtime | One lazy TeamRuntime Durable Object per TBA team key; owns team identity, season data, team-event states, team-scoped analytics, and the district membership fields reported by its own team provider record |
| Event-wide analytics | EventRuntime Durable Object; calculates event-level metrics from event inputs and TeamRuntime-owned team-event results |
| Team analytics | TeamRuntime Durable Object; independently calculates and persists team/season and team/event metrics |
| Roster reconciliation | Scheduled FieldView Worker Workflow; ordinary event reads do not reconcile rosters |

FieldView uses one `EventRuntime` per event and one `TeamRuntime` per TBA team key. These are two scopes of the same runtime abstraction: they accept the same explicit refresh command and follow the same acquisition, reconciliation, persistence, retry, and publication contract. Their differences are identity, owned resources, canonical state, and scope-specific derived outputs. A single polling coordinator determines eligible runtime targets and directly dispatches bounded commands. EventRuntime does not dispatch TeamRuntime work; the coordinator owns cross-runtime target selection and fan-out. Direct dispatch is the default; a Queue requires measured evidence that bounded direct calls are insufficient. EventRuntime owns event-scoped resources, FieldViewEventState, and FieldViewEventAnalytics. TeamRuntime owns team identity, season participation, FieldViewTeamState, FieldViewTeamEventState, and FieldViewTeamEventAnalytics. Cross-runtime dependencies use versioned references and operation-specific inputs; neither runtime persists another runtime's canonical records. See ADR-0016 and the accepted 2026-11-24 storage and polling decision.

## Runtime execution and cross-runtime orchestration (updated 2026-11-24)

EventRuntime and TeamRuntime are two scopes of one runtime abstraction. They must share the same lifecycle and refresh-command contract. The resource catalog, canonical aggregate, and derived outputs vary by scope; the execution model does not.

- **Runtime responsibilities:** accept an explicit refresh command; load local canonical state and validators; fetch owned provider resources directly; reconcile responses; persist meaningful canonical changes; publish versioned outputs; preserve last-good state on failure; and treat HTTP 304 as a strict no-op.
- **Polling coordinator responsibilities:** determine event lifecycle eligibility in each event's timezone; select EventRuntime and affected TeamRuntime identities; prevent overlapping dispatches; bound concurrency; prioritize work; and enforce aggregate request/storage budgets. It never performs entity provider I/O or constructs canonical deltas.
- **Direct dispatch is the default.** The coordinator invokes each runtime with one refresh command. It may use bounded sequential or concurrent dispatch. Do not add a Queue merely to batch calls; introduce one only when measured throughput, backpressure, or reliability requirements justify the added operational and quota costs.
- **Cross-runtime routing:** an event update does not automatically refresh every participating team. The coordinator identifies only the affected TeamRuntime targets from the triggering resource, event roster, or match alliance context. EventRuntime does not relay webhooks or dispatch TeamRuntime work.
- **Workflows:** Event readiness and Team readiness remain separately scoped durable Workflows where their discovery/coverage requirements differ. They use the shared runtime command contract; they do not own provider I/O or create a separate queue/alarm execution model.
- **Storage ownership:** Discovery contains discovery directories and metadata only. System Records contains Workflow execution, runtime registration, administrative actions, and operational history. Runtime Durable Objects own canonical EventState/TeamState and provider endpoint state. Do not store operational records in DiscoveryStore.
- **Scheduling transition:** existing per-runtime alarm and durable-queue code is transitional. Replace it with coordinator-owned lifecycle scheduling only after each trigger, retry path, analytics dependency, webhook follow-up, and recovery path has an explicit replacement. Do not remove an alarm until its responsibilities have moved and been validated.

### Asynchronous admin job execution (updated 2026-11-24)

All long-running admin work follows a durable submit/observe/execute lifecycle. The HTTP request persists a job record through System Records, creates or controls its owning Cloudflare Workflow, and returns HTTP 202. It does not perform entity provider requests or wait for a runtime refresh to complete. Workflows advance cross-runtime work through bounded direct dispatch, durable steps, sleeps, and persisted progress. EventRuntime and TeamRuntime accept the same refresh command and perform their own provider acquisition and reconciliation. The coordinator bounds dispatch; runtime-local queues and alarms are not the default polling mechanism.

This contract covers team seed, event-team seed (including participant discovery), manual current-year discovery, historical-year discovery, coverage audits, and season ingestion. Workflow execution records are separate from Discovery data and canonical runtime state. Stopping routine polling must not cancel or strand already accepted admin jobs.

## 5. Incremental migration model

The legacy application remains operational while individual responsibilities move to the new implementation.

- A responsibility is first mapped and given a target owner.
- The new implementation is built behind a clear boundary.
- During validation, outputs may be compared against the old implementation.
- A single owner is selected for writes and authoritative publication.
- Consumers are migrated to the canonical FieldView domain model and its serialized representation.
- The old implementation is retired only after all callers and operational dependencies have moved.

Do not build a permanent dual-write system. If temporary mirroring is needed for validation, it must be read-only from the comparison side, observable, and explicitly time-limited.

## 5.1 Redis retirement strategy

Redis is retired incrementally by responsibility, not by globally disabling the connection or deleting the package at the start of the migration.

For every Redis-backed use:
1. Inventory its callers, data semantics, consistency requirements, and failure behavior.
2. Implement the target owner or transport in the architecture defined above.
3. Migrate callers and validate behavior, including concurrency, freshness, recovery, and failure cases.
4. Remove the Redis-backed implementation from active execution paths while retaining its source code as inactive migration/rollback material.
5. Record the deactivated responsibility and remaining Redis consumers in this plan.

Do not break a feature merely to make Redis unused. In particular, remote-session signaling/presence and the legacy WebSocket bridge remain operational until their Cloudflare replacements are implemented and validated. Redis response caches, provider request coordination, webhook cache mutation, and any other provider-specific use are separate migration slices; do not assume that replacing one retires the others.

The Redis client module, ioredis dependency, and old implementation files remain in the repository until a repository-wide runtime/deployment audit confirms that no valid execution path, test, script, or operational workflow requires Redis. Only then may the Redis code and dependency be deleted. Production configuration is not changed as part of branch-only migration work.

### Initial provider-cache migration progress

The first provider slice is being moved into the existing Durable Object owners:

- **EventRuntime** owns TBA event endpoint representations and the event-scoped Statbotics match collection.
- **TeamRuntime** owns TBA team resources, Statbotics team-year/team-event resources, and FRC Colors team identity data.
- TeamRuntime now persists a canonical TeamState publication keyed by the contributing endpoint revisions and freshness metadata. Unchanged reads reuse that exact publication. Rebuilds use a consistent endpoint read set and publish the new State and compatibility key together in one storage transaction, only if the inputs still match the read set.
- The Vercel Statbotics match API now reads the event-scoped collection from EventRuntime instead of invoking the Redis-backed Statbotics client.
- The Vercel TBA webhook endpoint now relays the signed raw request to the Worker. EventRuntime applies the webhook reconciliation. The Vercel relay still emits the legacy WSS notification through the existing Redis pub/sub bridge; that Redis use remains valid until all WSS consumers have moved.
- The Worker webhook ingress requires the Cloudflare secret `TBA_WEBHOOK_SECRET` to match the HMAC secret configured with TBA. The Vercel compatibility relay requires `NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL`. This branch does not modify external secrets, TBA webhook settings, or production routing.

This is not yet the final Redis-removal audit. Legacy provider client modules and their implementations remain in place as requested, and their complete import/runtime reachability still needs to be verified before they can be considered safe to delete.

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

**Status:** Complete. TBA and Statbotics provider workspaces own their generated schemas, provider type aliases, and generation scripts. The first-class FieldView domain model is documented in `docs/domain/FIELDVIEW-DATA-MODEL-V1.md`, using Archimedes SF13 as its reference case. Initial types now exist for team, season, event, event-team, match, playoff-alliance, provenance, and analytics concepts. `FieldViewMatch` retains the exact TBA match type and adds explicitly typed Statbotics associations, independent predictions, analysis, playoff associations, and evidence-bearing flags. An initial pure `normalizeFieldViewMatch` composition boundary now associates the independent TBA match, TBA event prediction, TBA event OPR, and Statbotics match resources. It preserves the original TBA match fields, keeps predictions independent, correlates Statbotics EPA through the official TBA team_number field, and associates EPA/OPR values without mutating source records. Archimedes SF13 fixture tests cover source preservation, independent predictions, roster-order associations, and correlation without a synthetic Statbotics ID. The FieldViewMatch normalization and JSON round-trip tests passed CI (run 44011552550). The event-team normalization boundary composes TBA team-event status and event-level OPR/DPR/CCWM without changing source values; its association and JSON round-trip fixture tests passed CI (run 44012193065). A team-season normalization boundary now retains the unchanged Statbotics team-year record and uses TBA team_number to match the unchanged Statbotics team value and rejects mismatches; tests cover identity absence and JSON round-trip. Resource provenance is now part of each provider-backed aggregate: team, event, team-season, event-team, match, and playoff-alliance models carry per-resource metadata, including TBA team records used for Statbotics correlation. Fixture tests cover source preservation, associations, missing-versus-null behavior, and direct JSON round trips for match, event-team, and team-season objects. Playoff-alliance association now uses exact TBA Event Team Status alliance.name matching (never response order or alliance number). JSON round-trip coverage now spans every non-analytics canonical aggregate: team, team-season, event, event-team, match, and playoff alliance. Missing-data review has tightened source metadata into a discriminated union that disallows contradictory status/timestamp combinations, and match classification explicitly treats practice and qualification matches as non-playoff. Analytics result/coverage semantics are now defined in `docs/analytics/DOMAIN-RESULT-CONTRACT.md` and implemented as canonical domain types. The contract separates observation sample size, eligible/excluded population counts, peer-comparison coverage, prior-event baselines, metric availability, and typed evidence/findings. Fixture tests cover JSON round trips, insufficient versus unavailable data, numeric zero, and comparison denominators. There will be no separate DTO package or duplicated client model; the domain objects themselves are the application data model.

**Work**
- Define canonical models including FieldViewTeam, FieldViewTeamSeason, FieldViewEvent, FieldViewEventTeam, FieldViewMatch, FieldViewPlayoffAlliance, and analytics result types.
- Define metric status, sample size, eligible population, comparison coverage, prior-event baseline, and typed finding/evidence semantics.
- Finalize the canonical FieldView domain objects that are shared by backend and client.
- Define and enforce missing vs null vs explicit clear semantics, including the meaning of each source availability state. Domain value and provenance distinctions are enforced; persistence/refresh merge behavior and authoritative-clear handling are implemented with the provider/runtime layers in M4/M5.
- Add pure normalization boundaries for event/team relationships and other approved aggregates. The team-season and event-team seams are implemented; review playoff-alliance association before adding any further boundary.
- Add fixture-driven domain and serialization tests. Validate transport serialization of the domain objects rather than defining a second schema.

**Exit criteria**
- Domain builds independently of Next.js and Cloudflare, with provider workspace packages available only for unchanged source field types.
- Canonical domain objects serialize and deserialize through the selected transport without changing their defined values or missing/null semantics.
- The domain package is ready for backend and client use, with no Next.js or Cloudflare runtime dependency. Actual frontend consumer migration and removal of browser-owned provider acquisition are tracked in M7.

### M4 — Provider adapter migration

**Status:** In progress. TBA and Statbotics HTTP transports and provider-owned endpoint path builders are in place. Platform-independent EventRuntime endpoint-state transitions are implemented and tested, including endpoint-scoped validators, 304/200/failure behavior, webhook validator preservation, and poll/webhook race reconciliation. The architecture is recorded in ADR-0007. These primitives are bound to the initial EventRuntime Durable Object adapter in the migration branch; no Worker or Durable Object is deployed. The first provider-owned runtime boundaries are in place for TBA and Statbotics HTTP transport: `@fieldview/provider-tba/client` owns the TBA base URL and authentication header, while `@fieldview/provider-statbotics/client` owns the Statbotics base URL and `/v3` prefix. Both return native responses so cache validators and provider payloads remain unchanged. The existing Redis cache/reconciliation layer remains in the web workspace temporarily and now delegates network requests to this provider client. This is an incremental extraction, not a completed provider migration. The web TBA service routes its active event, team, and match resource paths through the provider-owned endpoint builders; cache webhook mutation uses the same builders. The TBA builder set covers the legacy service's complete current endpoint surface and has expanded path/encoding tests. Provider transport tests also explicitly cover unchanged non-success HTTP responses (including retry metadata), propagation of network failures, and malformed JSON remaining uninterpreted at the transport boundary. These tests protect the rule that providers return raw responses while cache/runtime adapters own retry, stale-data, parsing, and fallback policy. Statbotics already uses provider-owned endpoint builders for all resource and collection requests. FRC Colors response interpretation and the compatibility color shape remain application-owned for now and are explicitly not part of the stateless transport extraction.

**Work**
- Introduce isolated TBA, Statbotics, and FRC Colors adapters. TBA, Statbotics, and FRC Colors HTTP transports and path builders are provider-owned. Durable endpoint state and reconciliation transitions live in the runtime layer, not in the provider package; the legacy Redis adapter remains temporarily operational. The FRC Colors stateless HTTP transport and endpoint builder now live in the provider workspace; Redis caching, response interpretation, and the legacy analytics-facing shape remain in the web workspace temporarily.
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
- Frontend consumers do not import provider-generated types or provider acquisition implementations; the domain may reference provider types for unchanged source fields.

### M5 — Cloudflare backend and event runtime

**Work**
- Establish Worker entrypoints, environment bindings, deployment configuration, and local development. The isolated prototype Worker `fieldview-runtime-prototype` is deployed on `workers.dev` with separate SQLite Durable Object namespaces and the Vercel migration preview is configured to use it. Health, runtime command-center operations, event refresh, team seeding, and canonical snapshot reads have been exercised successfully. Production routing and production deployment remain untouched.
- Implement the first EventRuntime Durable Object using the accepted ownership and conditional-fetch rules in ADR-0007. It owns event resources and accepts direct refresh commands; the coordinator determines recurring polling eligibility and timing. The initial DO persists endpoint representations and validators, retains each accepted upstream 200 payload as an immutable revisioned source record, applies webhook updates transactionally without rewriting source records, and schedules TBA endpoint polls through one durable alarm. Public `/snapshot` reads only publish retained state; explicit refresh, lifecycle activation, and webhook work initiate acquisition. Each alarm processes at most one provider request and staggers remaining due work. Statbotics enrichment is not independently polled: a changed accepted TBA event/team/status/match REST representation schedules a debounced refresh with at most four attempts (one initial request plus three bounded retries on provider failure or HTTP 304). Retry exhaustion ends that trigger; a later meaningful TBA representation change may start a new refresh, and failed attempts preserve the last good data. This first adapter is implemented and typechecked; Cloudflare deployment is intentionally deferred.
- Establish authoritative event-state ownership, persistence, and reconciliation. The event-scoped owner and endpoint transitions are implemented.
- Establish authoritative team-state ownership. One TeamRuntime per TBA team key owns team identity, district membership references, season event lists, and team media, with independent endpoint validators, provenance, and last-good retention. It uses the same direct refresh contract as EventRuntime. TeamRuntime initializes and persists a possibly partial FieldViewTeamState for the requested season on its first request and refreshes the persisted aggregate after provider polling. It now also calculates and persists its own FieldViewTeamEventAnalytics and FieldViewTeamEventState from event calculation context plus a versioned FieldViewEventTeamSeasonComparisonInput assembled by EventRuntime from all participant TeamStates. TeamState changes notify known EventRuntimes, which rebuild the shared comparison input and request recalculation. TeamRuntime also owns and caches the season-level diagnostics aggregate built from its persisted TeamEventStates, validating both team and event source revisions. EventRuntime no longer publishes or persists team-owned analytics; its publication contains event/match analytics plus event-wide rankings and EPA-change aggregates derived from TeamRuntime results. EventRuntime composes current TeamRuntime states on `/snapshot` and `/view` reads without persisting duplicate team-state copies. Public `/teams/:teamKey/snapshot?year=YYYY` reads are read-only; explicit authenticated refresh/seed operations enqueue durable acquisition work. Each TeamRuntime alarm processes at most one provider request and spreads remaining due resources across subsequent alarms. Event-scoped resources remain in EventRuntime.
- Implement webhook invalidation and coordinator-dispatched authoritative refreshes. Signed TBA webhook ingress, deduplication, raw-payload retention, match updates, durable per-event polling alarms, and the immediate-plus-65-second one-shot authoritative TBA REST refetch behavior are implemented. This historical milestone originally used TaskScheduler for discovery and lifecycle scheduling; that global coordinator has since been retired. DailyEventReadinessWorkflow now owns scheduled discovery/classification and initializes EventRuntime instances, while each EventRuntime alarm owns its event-local polling and completed-retention behavior.
- Compose canonical event snapshots. TBA event, team, event-team, match, prediction, OPR, playoff-alliance, event-ranking, event-award, and event-advancement-points composition is implemented through `@fieldview/domain`; Statbotics match enrichment is triggered only by accepted changes to TBA event/team/status/match REST representations. It uses a debounced refresh with at most four attempts (initial request plus three bounded retries on provider failure or 304); there is no independent Statbotics polling. A later TBA representation change can trigger a new refresh. Broader Statbotics team-year/team-event resources remain pending.
- Implement versioned publication and client subscriptions. ADR-0007 establishes revision-only publication and canonical snapshot recovery; ADR-0008 selects one browser WebSocket per SharedWorker connection to one shared Multiplexer Durable Object. That multiplexer serves multiple browser clients, deduplicates each topic subscription, and forwards revision-only notifications only to clients subscribed to the changed topic. EventRuntime remains the event-state owner; the authoritative analytics publisher owns analytics revisions independently. Runtime publishers notify the multiplexer only for topics with interested clients. Gameday's up-to-nine event tiles and other live-data pages share the same SharedWorker channel. The browser-facing channel is public and read-only; internal subscription registration and notification delivery remain service-authenticated. The single shared Multiplexer Durable Object, public `/stream` gateway, EventRuntime topic registration, revision-only notification delivery, multi-client filtering, and generation-ordered upstream registration reconciliation are implemented and covered by Worker tests. An opt-in SharedWorker runtime transport now connects to the shared multiplexer, replays event-state and analytics subscriptions after reconnect, and recovers canonical event snapshots and versioned analytics publications through their public read endpoints. Canonical EventView, Match Insights, tile, and analytics surfaces now consume the canonical snapshot/publication path. The legacy EventState REST path remains only as compatibility for consumers not yet migrated. EventRuntime publishes analytics with a revision independent of event-state revisions and notifies the Multiplexer analytics topic. The isolated prototype Worker is deployed and has been exercised; production cutover has not occurred. Add sharding only if measured demand or platform limits justify it.
- Keep read-only public event access separate from server-to-server administration. The runtime admin bearer token protects scheduling, state inspection, webhook delivery, and other internal operations; it is never exposed to browsers.

**Exit criteria**
- Each event and team has one authoritative runtime owner.
- Concurrent refreshes cannot publish stale results over newer data.
- Failed refreshes do not erase valid state.
- Restart/recovery and reconnect behavior are tested.
- The old backend remains available for unaffected responsibilities.

### M6 — Analytics engine migration

**Status: Complete.** Functional engine migration and archive-backed parity validation are complete. The current invalidation executor deliberately retains whole-event recalculation for all sources; selective partial recalculation is not enabled while shared event-wide baselines remain coupled.

**Work**
- Define a small registered operation vocabulary.
- Implement a generic engine for input resolution, validation, operation execution, and standardized output.
- Express metrics as versioned declarative definitions.
- Support both single-entity and collection/event-wide calculations.
- Keep calculation, interpretation, summary text, and presentation separate.

**Progress**
- Pure calculation implementations live in `packages/analytics` as registered operation implementations. The unused web calculation facade has been deleted; the obsolete Next.js progressive event orchestration is gone. Legacy `/api/insights` endpoints remain only as redirects to canonical EventRuntime/TeamRuntime routes.
- A versioned definition catalog now documents current calculation inputs, source paths, inclusion/exclusion rules, formulas, thresholds, units, and limitations. The catalog records current behavior for hand verification; it does not certify the mathematics.
- A generic `AnalyticsEngine` now validates definition identity/version, resolves only allowlisted operation keys, validates required versus optional resolved inputs, and returns versioned execution results. `AnalyticsOperationRegistry` is an explicit in-process allowlist; source paths remain descriptive metadata and are never evaluated. The default FieldView registry covers every operation key in the current catalog, with tests for registry coverage, duplicate registration, missing inputs, unknown definitions/operations, optional-input warnings, and a real calculation invocation. Canonical EventRuntime and TeamRuntime analytics now execute alliance, qualification, match-flag, playoff, team-row, team-investigation, and season-comparison calculations through this engine; the calculation functions remain pure operation implementations. Historical parity is now covered by archive-derived fixtures for the complete CTHAR and MAWNE match collections. The fixtures validate alliance-side results, qualification calibration/anomalies, playoff aggregation, findings, Team 3461's TeamRuntime investigation, and its CTHAR-vs-MAWNE season comparison against the direct calculation implementations. Team 3461's full match appearance populations are 15 at CTHAR and 14 at MAWNE; the season EPA comparison is 14.70 to 45.72 (+31.02). The fixture intentionally includes only Team 3461 team-level metadata/EPA history, so it does not claim all-team percentile or OPR/DPR/CCWM parity.
- Deterministic audit-manifest hashing is implemented, including source revision/fetch metadata and the definition versions used by a run.
- Match-review flags (model upset, phase-specific anomaly, large residual, high penalties, and high alliance EPA) are calculated by the shared analytics package; the dashboard renders server-supplied evidence rather than recalculating thresholds in the browser.
- EventRuntime calculates and publishes `FieldViewMatch.analysis`, `FieldViewMatch.flags`, and event-wide metrics/findings only. TeamRuntime calculates and persists team-at-event EPA/component/percentile/contribution metrics, season comparisons, peer performance, and review findings in its own FieldViewTeamEventAnalytics / FieldViewTeamEventState.
- Match, event, and team analytics share an audit envelope with provider source revisions, fetch timestamps, record coverage, definition versions, engine version, warnings, and deterministic input digest.
- `FieldViewEventSnapshot` → `FieldViewEventState` is the primary event normalizer/Worker model naming. Team naming is standardized: `FieldViewTeamState` is the team-profile/season aggregate; `FieldViewTeamEventState` is the per-team/per-event aggregate; `FieldViewTeamEventAnalytics` is its team-specific analytics. `FieldViewEventTeamSeasonComparisonInput` is the versioned shared input assembled by EventRuntime from all participant TeamStates. The old `FieldViewTeamSnapshot` and `FieldViewTeamAnalytics` names remain deprecated compatibility aliases.
- EventState normalization now produces event-owned canonical data only; it does not construct or embed TeamEventStates. TeamRuntime alone normalizes, calculates, persists, and serves its per-team/per-event state. EventRuntime's `/snapshot` and `/view` endpoints retrieve those independently owned records and compose them with explicit roster coverage.
- Canonical analytics recalculation currently has persisted, coalesced EventRuntime alarm work; migrate this trigger to explicit coordinator/Workflow dispatch so alarms are not the general polling scheduler. Provider endpoint revision changes and match webhooks schedule the job; public snapshot reads only overlay the last published analytics and do not execute calculations. Publication is revision-checked, retains the last good analytics on calculation failure, retries after a delay, and increments the canonical snapshot revision when a new publication succeeds. The admin runtime inventory exposes job status, due time, last calculation time, source revision, and last error.
- The canonical package publishes detailed qualification diagnostics, residual anomalies, official playoff-alliance performance, team investigation summaries/trends/peer comparisons/review matches, event team comparison rows, alliance-side results, residual summaries, and prediction/collection coverage. EventRuntime builds `FieldViewEventTeamSeasonComparisonInput` from the current event roster and every available TeamRuntime `FieldViewTeamState`, preserving unavailable team/event records instead of zero-filling and retaining the most-recent-prior-event baseline semantics. It passes the same revisioned input and event context to each TeamRuntime. TeamRuntime calculates and persists its own `FieldViewTeamEventAnalytics` / `FieldViewTeamEventState`; TeamState changes notify known EventRuntimes, which invalidate and rebuild the comparison input. EventRuntime publishes only event-wide analytics; its event team summaries project team metrics from TeamRuntime results rather than recalculating EPA/component/contribution values from matches. `GET /view` composes `FieldViewEventState`, `FieldViewEventAnalytics`, and current TeamRuntime event states with explicit partial coverage. The public analytics read endpoint, independent analytics revision, Multiplexer notification, and SharedWorker subscription/recovery path are connected. Source-to-scope invalidation dependencies are explicit and tested (match, event, team, playoff, and season scopes), with match-key coalescing. All current sources retain the whole-event execution fallback because event residual distributions and peer/team baselines share dependencies; no unsafe partial recalculation is enabled. The Event Analytics dashboard consumes the canonical EventRuntime publication through SharedWorker.

**Next**
- Validate scheduled FieldView Worker Workflow roster reconciliation updates TeamRuntime event memberships and triggers event comparison-input rebuilds for additions/removals.
- Complete client/API migration to consume FieldViewEventView and remove deprecated FieldViewTeamSnapshot / FieldViewTeamAnalytics compatibility aliases when all consumers are migrated. The obsolete season-cohort model/module aliases have been removed.
- Keep whole-event recalculation as the safe fallback. Selective recalculation is a later optimization that requires independently maintained metric baselines and parity tests before any source can bypass the full-event path.
- Remove any remaining legacy analytics services and Redis callers only after their frontend consumers are migrated. Independently hand-verify the math later and make any corrections as deliberate definition-version changes.

**Exit criteria**
- Definitions contain no arbitrary executable code or provider fetches.
- Historical fixtures validate migrated outputs.
- Missing-data and sample-size behavior is explicit.
- Event-wide rankings and comparisons report their actual eligible population.

### M7 — Frontend and product-surface migration

**Progress**
- The server-rendered event page consumes `FieldViewEventSnapshot` exclusively and no longer makes direct TBA requests; missing snapshots/resources render as unavailable until EventRuntime has acquired them. The events browser consumes `FieldViewEvent` objects exclusively from the global scheduler discovery cache and explicitly reports when discovery has not populated the cache. Neither route has a provider fallback. Event lifecycle boundaries use event-local IANA timezones, and discovery provenance distinguishes current from stale cached data. Explicit nulls remain unavailable rather than being overwritten. These are incremental source migrations, not a production cutover.
- The SharedWorker exposes canonical event snapshot subscriptions, reconnect recovery, runtime connection status, and an explicit snapshot re-read command. Gameday `EventView` now renders event, teams, matches, event-team statuses, and playoff alliances exclusively from `FieldViewEventSnapshot`; it no longer subscribes to legacy EventState. Upcoming-match alerts and tracked-team highlights are derived from canonical matches and event-team status. Connection health and manual snapshot refresh use the canonical SharedWorker path.
- The team profile reads team identity, season event discovery, and team media from TeamRuntime; district membership is displayed directly from TeamRuntime's own provider record. Event-specific details are read exclusively from EventRuntime snapshots: matches, event-team status, playoff alliances, rankings, awards, and advancement points. The page no longer makes direct TBA requests or imports provider schemas; resources that are not yet acquired remain explicitly unavailable rather than triggering a parallel provider path. It composes both canonical aggregates without duplicating event-scoped ownership.
- The homepage event cards and match summaries now consume `FieldViewEvent` and `FieldViewMatch` from canonical discovery/snapshot reads. Homepage card and countdown props no longer import TBA event/match schemas; shared match-selection helpers use a small structural match shape so remaining legacy EventState consumers can continue working during their own migration.
- Gameday's event footer, match strip/cards, tracked-team pills, rankings, team picker, and Statbotics prediction panel now use canonical domain models or narrow presentation projections of those models. Statbotics prediction values and availability come from each canonical match's prediction/provenance fields rather than browser-owned Statbotics records. The active-event picker API, tile state, and remote add-event action now carry `FieldViewEvent` objects.
- The Match Insights surface now subscribes directly to `FieldViewEventSnapshot` and renders `FieldViewMatch` records. Alliance OPR/DPR/CCWM and pre-match EPA values are read from the match's canonical team associations; Statbotics prediction and availability come from the match's prediction/provenance fields. The divisional-event selector also uses the canonical `FieldViewEvent` model.
- Tile View's imminent-match notification source now derives the next match from canonical event snapshots; the banner, score breakdown, prediction bar, and prediction metrics use canonical match types. The Event Analytics dashboard now receives the canonical `FieldViewEventSnapshot` and the durable, independently versioned EventRuntime analytics publication through the SharedWorker analytics subscription. A presentation adapter maps `FieldViewEventAnalytics`, `FieldViewTeamEventAnalytics`, canonical match analysis/flags, and TeamRuntime season data into the dashboard's existing view model; the six panels, labels, styling, layout, and interactions are unchanged. The dashboard no longer fetches `/api/insights/event`; canonical event analytics are also exposed under `/api/event/:event/analytics`, and legacy event-insights API requests redirect there. Team history now reads canonical TeamRuntime snapshots under `/api/team/:team/history`; team match investigation now reads canonical TeamRuntime season analytics through `/api/team/:team/matches` and no longer uses Redis or direct provider acquisition.
- Remote sessions now subscribe to versioned canonical EventRuntime snapshots, transmit `FieldViewEventSnapshot` values over the existing session channel, and render remote event cards from those snapshots. They no longer transmit or consume `EventStateSnapshot` provider-shaped payloads.
- District membership remains part of the owning TeamRuntime/EventRuntime provider records. No separate district domain aggregate or district-owned acquisition/query lifecycle is maintained.

**Work**
- Keep the aggregate Event Analytics dashboard on the canonical EventRuntime publication contract; preserve the current six-panel visual presentation and analytical semantics while replacing only its data adapter. Complete historical parity validation before removing legacy calculation implementations.
- Finish migrating the team match-investigation endpoint to canonical TeamRuntime/EventRuntime data and remove its remaining Redis/provider calls.
- District-owned records, routes, pages, and navigation have been retired; team/event district membership remains available from those entities' own snapshots.
- TeamRuntime Statbotics team-year/team-event resources use TBA-change-triggered refresh commands instead of recurring polling. The coordinator dispatches only affected team resources; TeamRuntime performs its own conditional requests. Changed TBA team identity or season event-list representations enqueue the relevant Statbotics resources; explicit seed/refresh remains supported, last-good data is preserved by endpoint-state reconciliation, and legacy recurring Statbotics tasks are removed on next TeamRuntime access. Worker tests cover trigger behavior and cleanup.
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

The first backend vertical slice is **an event-scoped canonical snapshot**, now implemented through TBA event metadata, teams, event-team statuses, matches, predictions, OPR/DPR/CCWM, and playoff alliances. A second entity slice now establishes one TeamRuntime per team for identity, provider-reported district membership, season event discovery, and media.

It exercises:
- provider-owned TBA transport and endpoint paths;
- durable per-endpoint state, validators, and immutable provider source versions;
- signed webhook ingestion and poll/webhook reconciliation;
- FieldViewEventSnapshot and its canonical child domain objects;
- serialization of the same domain aggregate from an authenticated EventRuntime snapshot route.

Statbotics event-match enrichment is implemented as TBA-change-driven one-shot acquisition, and TeamRuntime team-year/team-event enrichment now follows the same TBA-change-triggered, non-recurring policy. The shared Multiplexer, SharedWorker reconnect/recovery, canonical event and team snapshots, and analytics publication/subscription path are implemented. The prototype Worker has been deployed and exercised through the Vercel migration preview. Analytics migration and historical parity validation remain active work; production deployment and cutover remain prohibited until explicit acceptance.

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
| Durable Objects become too numerous or tightly coupled | Use one lazy object per event/team aggregate only where it owns an independent acquisition and refresh lifecycle; do not create objects for individual domain interfaces |
| Analytics migration changes historical interpretations silently | Version metric definitions and compare against historical fixtures |
| Frontend retains hidden provider dependencies | Enforce package boundaries and inspect dependency graph/imports |
| Production migration disrupts live events | Keep legacy path available until validated cutover and rollback |

## 10. Immediate next actions

1. M3 domain contracts and M4 provider transports are established; continue validating provider failure/partial-data behavior as runtime consumers move off legacy adapters.
2. Finish M6 historical analytics parity and refine dependency-aware recalculation only where correctness can be preserved; keep whole-event recalculation as the safe fallback.
3. Retire unused Next.js progressive analytics orchestration and legacy Redis/provider callers only after historical parity and compatibility checks; preserve the existing Vercel production path until an approved cutover.
4. Before production readiness, replace prototype bearer-token administration with a proper system-administrator authorization design, establish rollback/observability procedures, and obtain explicit production-cutover approval.

**Current implementation status:** The migration branch now contains the canonical FieldView domain and analytics contracts, provider-owned TBA/Statbotics/FRC Colors transports, and the Cloudflare Worker runtime with one EventRuntime per event, one TeamRuntime per team, FieldView Worker Workflows for durable cross-runtime orchestration, and a shared Multiplexer. The global TaskScheduler Durable Object, implementation, binding, and runtime routes have been removed. The isolated `fieldview-runtime-prototype` Worker is deployed on `workers.dev`; the Vercel migration preview points to it and the user has confirmed the command center, event refresh, team seeding, and canonical reads are functioning. The deployed Worker predates the latest TeamRuntime Statbotics refresh-policy correction, which is implemented on the branch and covered by passing Worker tests; redeploy the prototype config to exercise that correction remotely. Canonical event, team, analytics, SharedWorker, and remote-session consumers are substantially migrated. TeamRuntime Statbotics team-year/team-event data now refreshes only after changed TBA team or season-event-list representations, and legacy recurring Statbotics tasks are removed on object access or alarm startup. District directory/detail pages, APIs, domain contracts, and TaskScheduler-owned district records have been removed; team/event membership remains in the owning snapshots. Remaining M6 work is historical analytics parity, dependency-aware recalculation, and retirement of unused progressive/legacy analytics code after parity. Remaining M7 work is auditing residual compatibility consumers and removing legacy provider acquisition only when production cutover is safe. M8 still requires proper system-administrator authorization (the current runtime admin bearer token is prototype-only), operational observability, rollback rehearsal, and explicit production approval. No changes to `main`, production Worker routing, production secrets, or production frontend traffic have been made.


### TeamRuntime decision and first implementation slice (2026-11-18)

The team aggregate has an independent acquisition and canonical-state scope, so it receives one `TeamRuntime` Durable Object per TBA team key. Its refresh execution follows the same direct command contract as EventRuntime. Its first canonical resources are the TBA team record, team district memberships, the team's event list for a requested season, and team media for that season. Each resource retains independent endpoint state, validators, freshness/provenance, and last-good data. Public snapshot reads are read-only and never schedule provider acquisition; authenticated refresh/seed operations issue explicit self-fetching refresh commands, with scope-local bounded provider requests. A failed refresh never replaces the last usable representation. Event-scoped matches, rankings, awards, alliances, and team-event status remain owned by EventRuntime and are not duplicated in TeamRuntime. Discovery and System Records use logically separate D1 schemas/repositories under the accepted 2026-11-24 storage decision; canonical runtime state remains in Durable Objects.


### Analytics dashboard continuation (2026-11-19)

The event analytics dashboard now consumes canonical EventRuntime publications and canonical event snapshots through the SharedWorker. The dashboard retains its existing presentation adapter and six-panel UI. Analytics recovery must be requested through the SharedWorker message port: calling the worker transport singleton from the browser page is a separate instance and cannot refresh the worker-owned WebSocket. The client now sends an explicit `refreshCanonicalAnalytics` message, and the SharedWorker performs the durable publication read. The analytics hook requests recovery on mount so it does not depend solely on a WebSocket subscription acknowledgement.

The Team Investigation view no longer issues two unused TeamRuntime history requests when a team is selected; those responses were never rendered. The canonical team history route remains available for compatibility and validates numeric team keys correctly. The season-wide `/api/team/[team]/matches` route is now a thin compatibility proxy to the Worker-owned `/teams/{team}/analytics` endpoint. The Worker composes the TeamRuntime season event inventory with canonical EventRuntime snapshots, reuses each event's published `FieldViewTeamEventAnalytics.match_evidence`, and runs the existing season diagnostics from `packages/analytics`. The response retains the existing investigation DTO and per-event pending/unavailable/ready states; an unavailable event no longer fails the entire season response. The Next.js route no longer orchestrates event reads or performs season aggregation. Remaining work is parity validation against known historical cases (including `2026cthar`) and migration of any other legacy team-investigation consumers.

No visual redesign, merge, deployment, secret change, or production cutover is part of this slice. Workspace validation for the runtime aggregation and failure-handling changes passed in CI run 44683783383, including workspace typechecking and tests. The request-time Worker aggregation is an incremental ownership move, not yet a durable season analytics publication; the next architecture step is to define revision-aware season-result reuse against TeamRuntime and EventRuntime publication revisions before adding persistent caching.

### Team Investigation runtime aggregation (2026-11-20)

The season-wide team investigation read path now delegates to the Worker. It aggregates only canonical TeamRuntime and EventRuntime snapshots and keeps calculations in the existing analytics package. The public response preserves the existing UI contract and reports individual event failures as unavailable/partial rather than failing the whole season request. The Next.js API route is now a compatibility proxy only.

### Dashboard canonical compatibility correction (2026-11-18)

- The event analytics adapter now exposes canonical match flags on the legacy dashboard record's top-level `flags` field, matching the existing Suggested Review consumer. Keeping flags only on the nested canonical match object made every flag appear absent.
- The adapter now falls back to canonical per-alliance match score analysis for predicted scores and score deltas when the event analytics aggregate omits those values. It does not calculate new analytics in the browser; it projects already-published EventRuntime analysis into the compatibility view model.
- Preserve the canonical publication as the source of truth. Do not restore client-side flag calculation or provider fetches to work around missing publication data.


### Event-local weekly classification (2026-11-20)

ADR-0010 defines event-local Monday-Sunday classification using inclusive date-only ranges. `DailyEventReadinessWorkflow` resolves TBA's canonical current season, refreshes/publishes Event Discovery, publishes the read-only `GET /events/this-week` projection, and inspects EventRuntime readiness. `DailyTeamReadinessWorkflow` independently resolves the same canonical current season, refreshes/publishes Team Discovery, and inspects TeamRuntime readiness. Neither workflow queues refreshes, schedules provider I/O, or waits for entity refreshes. They have separate Workflow bindings, concurrency limits, and progress summaries.

The daily projection is consumed by the Next.js homepage through `getCanonicalEventThisWeek`. The readiness sweep is a coverage inspection, not the live polling scheduler. It does not queue local provider work. The polling coordinator evaluates `events-this-week` at dispatch time, selects only currently active events, and directly dispatches one refresh command per eligible EventRuntime plus commands for affected TeamRuntimes. Each runtime performs its own bounded provider acquisition. Frontend-facing state reads return 404 until a valid canonical publication exists; after publication, the last-good state remains readable while stale sources are refreshed. Public reads never initiate initialization or provider work. Current-match/webcast enrichment remains separate from initial home-page rendering. GitHub CI is the validation gate. Production activation has not occurred.

### District membership-only decision (2026-11-21)

District membership is a property of a team's or event's own provider data. The former TaskScheduler-owned directory/snapshot implementation and all district-specific acquisition and query routes have been retired. Legacy scheduler-owned district records are deleted on activation. No district feature should add a separate fetch until a concrete product requirement establishes what district information is needed.

**Next**
- Add focused tests for 200/304/404/failure handling, last-good retention, independent resource state, and read-only public routes; validate the full workspace in CI.
- Validate RuntimeAdminWorkflow behavior and admin dashboard compatibility under real Worker tests, then continue historical analytics parity and retire legacy EventState acquisition only after all required consumers have moved.


## Runtime ownership update (2026-11-20)

The target architecture uses independent EventRuntime and TeamRuntime Durable Objects under one shared runtime abstraction. Both implement the same lifecycle, explicit refresh-command, provider acquisition, conditional request, reconciliation, persistence, retry, and publication contract. EventRuntime owns event-scoped TBA and Statbotics resources; TeamRuntime owns team-scoped TBA, Statbotics, and FRC Colors resources. The polling coordinator selects affected scopes and dispatches directly; neither runtime dispatches work to the other or persists the other's canonical data. Event lifecycle determines event polling; team refreshes are dispatched only when team-owned data or projections are affected. Runtime alarms and durable local queues are transitional implementation details, not the target recurring polling model. Separate objects remain independently executable; no global provider-request lease or mutex is introduced. FieldView Worker Workflows orchestrate discovery, sequential readiness checks, event-week classification, and durable multi-entity maintenance. Discovery owns discovery directories and metadata in `discovery_records`; System Records owns workflow/operational records in `system_records`; Durable Objects own canonical runtime state.


ETag retention is indefinite for EventRuntime and TeamRuntime resources. Cache-Control freshness metadata determines when a resource should be revalidated, not when its ETag or last-good representation may be deleted. A 304 response retains the cached representation and validator; a missing representation after a 304 requires an unconditional recovery fetch.


## Runtime readiness and read-first publications (2026-11-21)

Runtime readiness combines ADR-0015's durable hydration boundary with ADR-0018's publication gate and sequential refresh policy.

- EventRuntime and TeamRuntime hydrate their own in-memory caches from durable storage on each activation, before handling requests. Hydration must not perform provider I/O or cross-runtime calls.
- Frontend-facing event/team state reads return 404 until a valid canonical publication exists. Public reads never create entity identity, initialize state, or queue provider work.
- Once a valid publication exists, public reads return the persisted last-good state immediately, even when stale. Refresh failures never replace or erase that publication.
- `DailyEventReadinessWorkflow` resolves current season and inspects EventRuntime publications; `DailyTeamReadinessWorkflow` independently resolves current season and inspects TeamRuntime publications. Both are inspection/coverage workflows and do not queue provider work or perform entity-scoped provider I/O.
- The polling coordinator dispatches direct refresh commands with bounded concurrency. Each runtime owns its own request ordering and overlap protection; separate Durable Objects may run independently, with no global provider-request lock.
- Event views and event analytics are prepared and published asynchronously. Ordinary event GETs must not fan out to all TeamRuntime objects to compose the response.
- The current season and its durable event/team directories are mandatory system state. Event readiness verifies/repairs Event Discovery; team readiness independently verifies/repairs Team Discovery. Public directory reads use persisted data and never initiate discovery.
- Readiness diagnostics must expose durable source coverage, publication version/completeness, activation hydration state, freshness, refresh-required status, last refresh outcome, and last error. Do not report a queued deadline when no durable queue exists. Object existence or Cloudflare hasStoredData is insufficient.
- Preserve the configured Statbotics testing mirror at `https://api-statbotics.iterativerefinement.com/` while the official service is unavailable.

The daily Workflow is scheduled for 10:00 UTC. The five-minute randomized window spreads refresh starts but is not a strict global concurrency cap. Do not deploy or cut over as part of this branch work.


### Independent event and team readiness (2026-11-23)

EventRuntime and TeamRuntime readiness are separate sequential Workflows:

- `DailyEventReadinessWorkflow` refreshes/publishes Event Discovery, maintains the this-week event projection, and inspects EventRuntime readiness without initiating provider refreshes.
- `DailyTeamReadinessWorkflow` independently resolves TBA's canonical current season, refreshes/publishes Team Discovery, and inspects TeamRuntime readiness for that season without initiating provider refreshes.
- Both have independent Workflow bindings, concurrency limits, and summary paths. They inspect readiness; the polling coordinator owns all refresh timing and dispatch.
- EventRuntime analytics must not dispatch to TeamRuntimes directly. The coordinator or a dedicated Workflow selects registered TeamRuntime targets and sends explicit, versioned analytics inputs/commands. Missing registry entries are reported as unavailable inputs; event readiness must not create TeamRuntimes.
- The GitHub Actions scheduled workflow starts both authenticated preproduction endpoints. Configure the repository secret `FIELDVIEW_PREPROD_ADMIN_TOKEN` with the preproduction Worker admin token. GitHub scheduled workflows run from the default branch, so the scheduler becomes active after this workflow file reaches that branch. The shared scheduler does not couple the two Workflows; scheduled activation is not configured through Cloudflare Workflow cron schedules.
- Event participant lists remain EventRuntime-owned data and do not imply TeamRuntime initialization.
