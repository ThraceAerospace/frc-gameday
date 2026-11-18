# FieldView Architecture Migration Plan

**Status:** M1 source inventory complete; M2 repository foundation complete; M3 domain foundation complete; M4 provider/runtime boundary in progress; M5 EventRuntime foundation in progress
**Target branch:** `fieldview-architecture-migration`
**Strategy:** Incremental migration
**Last updated:** 2026-11-18

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
  fieldview-runtime/           # Cloudflare Worker entrypoint and event Durable Object
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
| Scheduled refresh triggers | Durable Object alarms owned by EventRuntime and the global EventScheduler |
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

**Status:** In progress. TBA and Statbotics HTTP transports and provider-owned endpoint path builders are in place. Platform-independent EventRuntime endpoint-state transitions are implemented and tested, including endpoint-scoped validators, 304/200/failure behavior, webhook validator preservation, and poll/webhook race reconciliation. The architecture is recorded in ADR-0007. These primitives are bound to the initial EventRuntime Durable Object adapter in the migration branch; no Worker or Durable Object is deployed. The first provider-owned runtime boundaries are in place for TBA and Statbotics HTTP transport: `@fieldview/provider-tba/client` owns the TBA base URL and authentication header, while `@fieldview/provider-statbotics/client` owns the Statbotics base URL and `/v3` prefix. Both return native responses so cache validators and provider payloads remain unchanged. The existing Redis cache/reconciliation layer remains in the web workspace temporarily and now delegates network requests to this provider client. This is an incremental extraction, not a completed provider migration. The web TBA service now routes all of its event, team, match, and district resource paths through the provider-owned endpoint builders; cache webhook mutation uses the same builders. The TBA builder set covers the legacy service's complete current endpoint surface and has expanded path/encoding tests. Statbotics already uses provider-owned endpoint builders for all resource and collection requests. FRC Colors response interpretation and the compatibility color shape remain application-owned for now and are explicitly not part of the stateless transport extraction.

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
- Establish Worker entrypoints, environment bindings, deployment configuration, and local development. The Worker entrypoint, Wrangler Durable Object binding/migration, and runtime typecheck are now present; credentials and deployment remain unconfigured.
- Implement the first EventRuntime Durable Object using the accepted ownership and conditional-polling rules in ADR-0007. The initial DO persists endpoint representations and validators, retains each accepted upstream 200 payload as an immutable revisioned source record, applies webhook updates transactionally without rewriting source records, and schedules TBA endpoint polls through one durable alarm. Statbotics enrichment is not independently polled: a changed accepted TBA event/team/status/match REST representation schedules a debounced refresh with at most four attempts (one initial request plus three bounded retries on provider failure or HTTP 304). Retry exhaustion ends that trigger; a later meaningful TBA representation change may start a new refresh, and failed attempts preserve the last good data. This first adapter is implemented and typechecked; Cloudflare deployment is intentionally deferred.
- Establish authoritative event-state ownership, persistence, and reconciliation. The event-scoped owner and endpoint transitions are implemented.
- Implement webhook invalidation and event-local scheduled safety refreshes. Signed TBA webhook ingress, deduplication, raw-payload retention, match updates, durable per-event polling alarms, and the immediate-plus-65-second one-shot authoritative TBA REST refetch behavior are implemented. A global EventScheduler now discovers only the current calendar year hourly with ETag validation, prunes obsolete discovery caches and schedules outside that year, and applies configurable upcoming (30-minute), active live-resource (5-minute), and completed-event (24-hour retention) schedules. The completed-retention alarm has been validated against a local Durable Object: an already-expired deadline clears its marker and all recurring polling tasks without a manual lifecycle transition. Scheduler activation remains an explicit authenticated operation; no Cron Trigger is configured.
- Compose canonical event snapshots. TBA event, team, event-team, match, prediction, OPR, playoff-alliance, event-ranking, event-award, and event-advancement-points composition is implemented through `@fieldview/domain`; Statbotics match enrichment is triggered only by accepted changes to TBA event/team/status/match REST representations. It uses a debounced refresh with at most four attempts (initial request plus three bounded retries on provider failure or 304); there is no independent Statbotics polling. A later TBA representation change can trigger a new refresh. Broader Statbotics team-year/team-event resources remain pending.
- Implement versioned publication and client subscriptions. ADR-0007 establishes revision-only publication and canonical snapshot recovery; ADR-0008 selects one browser WebSocket per SharedWorker connection to one shared Multiplexer Durable Object. That multiplexer serves multiple browser clients, deduplicates each topic subscription, and forwards revision-only notifications only to clients subscribed to the changed topic. EventRuntime remains the event-state owner; the authoritative analytics publisher owns analytics revisions independently. Runtime publishers notify the multiplexer only for topics with interested clients. Gameday's up-to-nine event tiles and other live-data pages share the same SharedWorker channel. The browser-facing channel is public and read-only; internal subscription registration and notification delivery remain service-authenticated. The single shared Multiplexer Durable Object, public `/stream` gateway, EventRuntime topic registration, revision-only notification delivery, multi-client filtering, and generation-ordered upstream registration reconciliation are implemented and covered by Worker tests. An opt-in SharedWorker runtime transport now connects to the shared multiplexer, replays event-state subscriptions after reconnect, and recovers versioned canonical event snapshots through the public read endpoint. The existing legacy EventState REST path remains available as a compatibility layer; canonical UI consumption and analytics publisher/result recovery remain pending. The analytics topic is part of the multiplexer protocol, but an authoritative analytics publisher is not yet connected. Add sharding only if measured demand or platform limits justify it.
- Keep read-only public event access separate from server-to-server administration. The runtime admin bearer token protects scheduling, state inspection, webhook delivery, and other internal operations; it is never exposed to browsers.

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

**Progress**
- The server-rendered event page now consumes `FieldViewEventSnapshot` end-to-end: it prefers the runtime snapshot when required resources exist and normalizes its server-side TBA fallback before rendering, so provider-shaped objects do not cross the page boundary. The events browser consumes normalized `FieldViewEvent` objects from the global scheduler discovery cache, with server-side normalization of its TBA fallback. Event lifecycle boundaries use event-local IANA timezones, and discovery provenance distinguishes current from stale cached data. Explicit nulls remain unavailable rather than being overwritten. These are incremental source migrations, not a production cutover.
- The SharedWorker exposes opt-in canonical event snapshot subscriptions and reconnect recovery. Gameday `EventView` now subscribes to that canonical snapshot and prefers its event, teams, matches, event-team statuses, and playoff alliances when each resource has been acquired. Missing resources retain the temporary legacy fallback; explicit null and empty values remain authoritative. Match ordering and next/last-match selection are derived from canonical match records. The legacy EventState remains temporarily active for webhook-derived upcoming-match alerts, websocket status, manual refresh, and fallback while those responsibilities are migrated; this is an incremental read migration, not a cutover.
- The team profile now prefers the canonical event snapshot for event-specific details when event, matches, event-team statuses, playoff alliances, rankings, awards, and advancement points have all been acquired. It derives the team's match subset from canonical event matches and associates awards by exact TBA recipient team key. Explicit null event data is not replaced; unavailable match data is rendered distinctly. The legacy per-team TBA acquisition remains as a compatibility path until the canonical resource set is ready. Team identity, district membership, season event discovery, and avatar acquisition remain on their existing path.

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

The first backend vertical slice is **an event-scoped canonical snapshot**, now implemented through TBA event metadata, teams, event-team statuses, matches, predictions, OPR/DPR/CCWM, and playoff alliances.

It exercises:
- provider-owned TBA transport and endpoint paths;
- durable per-endpoint state, validators, and immutable provider source versions;
- signed webhook ingestion and poll/webhook reconciliation;
- FieldViewEventSnapshot and its canonical child domain objects;
- serialization of the same domain aggregate from an authenticated EventRuntime snapshot route.

Statbotics match enrichment is implemented as TBA-change-driven one-shot acquisition, with no recurring Statbotics polling. Analytics recalculation is a separate coalesced batch target (10-minute initial target, with a 5-minute option to evaluate) and remains unimplemented while analytics semantics are frozen. Statbotics team-year/team-event resources, browser client reconnect/snapshot recovery, and frontend consumption remain subsequent slices; the public read-only Worker snapshot/stream gateway and internal versioned WebSocket publication seam are implemented. Analytics work remains outside this migration scope until explicitly resumed.

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

1. M3 is complete: canonical domain models, normalization boundaries, provenance/missing-data semantics, analytics result/coverage contracts, and JSON round-trip fixtures pass workspace typechecking and tests. Continue M4 provider adapter migration; keep analytics calculation-engine work in M6.
2. After M3 exit criteria are met, begin M4 provider adapter migration while keeping provider payloads unchanged and documenting every approved association.
3. Continue the ADR-0008 frontend migration from the opt-in SharedWorker transport: migrate individual UI consumers to `FieldViewEventSnapshot` and remove their legacy provider-shaped acquisition only after parity checks. The SharedWorker now owns one opt-in browser WebSocket to the shared Multiplexer Durable Object, replays event-state subscriptions after reconnect, and recovers versioned canonical event snapshots. Connect analytics subscriptions/recovery when the authoritative analytics publisher and result endpoint are implemented. Preserve the legacy frontend data path until cutover is approved; measure actual load before considering additional multiplexer instances.
4. Keep the migration branch deployment pause and current Vercel root directory unchanged; do not enable deployments or change production settings as part of workspace work.

**Current implementation status:** ADR-0007 establishes EventRuntime as the event's authoritative state owner. TBA and Statbotics endpoint path builders/transports, TBA endpoint-state transitions, immutable source-version retention, a Cloudflare Worker entrypoint, and a SQLite-backed EventRuntime Durable Object adapter are implemented in the migration branch. The runtime verifies TBA `X-TBA-HMAC`, deduplicates and retains raw webhook deliveries, applies match webhook updates without changing HTTP validators, and schedules endpoint polling through durable alarms. The public read-only snapshot route composes canonical `FieldViewEventSnapshot` objects containing TBA event, teams, event-team statuses, matches, event predictions, OPR/DPR/CCWM, playoff alliances, rankings, awards, advancement points, and unchanged Statbotics event-match records. Statbotics match predictions and pre/post EPA values are associated by exact match key and TBA team_number; they remain independent provider observations with separate provenance. Statbotics requests are one-shot and driven only by changed TBA REST representations, never by recurring polling. Analytics recalculation is intended to be a separate coalesced batch, initially every 10 minutes (configurable to 5), and no analytics calculations or interpretations are performed by this ingestion path. Domain/runtime tests and Worker typechecking are in CI. No Cloudflare deployment or runtime secrets are configured. Lifecycle-aware event discovery and polling policy are implemented but not activated; broader Statbotics team-year/team-event enrichment and frontend client migration remain pending; public read-only snapshot access and the internal versioned publication seam are implemented; ADR-0008 now specifies one browser WebSocket per SharedWorker connection through one shared Multiplexer Durable Object serving multiple clients. It deduplicates event-state topic registrations and forwards revision-only notifications only to interested clients. The protocol distinguishes event-state and analytics topics, but only EventRuntime event-state publication is connected; analytics publisher integration remains pending. Gameday's up-to-nine event tiles and other live-data pages share the same channel. Additional multiplexers are deferred until measured demand or platform limits justify them. The multiplexer implementation and backend subscription tests are in place. The opt-in SharedWorker connection, event-state subscription replay, and canonical snapshot recovery path are implemented; UI consumers have not yet switched to canonical data, and analytics publisher/result integration remains pending. M3 analytics semantics are deliberately untouched and remain pending. The Next.js application is relocated to `apps/web` and registered as the `@fieldview/web` npm workspace. The root package manifest and lockfile remain authoritative. TBA and Statbotics schema/type-generation files, stateless HTTP transports, and endpoint builders have moved into `packages/providers`; Redis caching, throttling, and application-level service coordination remain in the web workspace pending runtime cutover. The first FieldView domain-model baseline is documented in `docs/domain/FIELDVIEW-DATA-MODEL-V1.md`; initial domain types and normalization boundaries are implemented for team, event, event-team, match, playoff alliance, and event snapshot aggregates; fixture tests cover their source associations, availability semantics, and JSON round trips. The workspace lockfile has been refreshed and pushed. The legacy Redis/SharedWorker/Vercel data path remains. The domain workspace and Worker runtime typecheck in CI. Fixture coverage includes match, event-team, team-season, and event snapshot serialization; playoff-alliance association is resolved through exact TBA Event Team Status alliance.name matching, with tests for backup members, missing/null names, mismatches, and ambiguity. M3 analytics result/coverage semantics are now defined in the canonical domain package, with separate observation/comparison populations, prior-event baselines, explicit metric status/value pairing, and typed evidence-bearing findings. Analytics calculations and the generic declarative engine remain deferred to M6. No Cloudflare Worker or Durable Object is deployed; only the implementation and Wrangler configuration exist in this migration branch. The isolated Cloudflare prototype has since been exercised locally with Wrangler: the Worker health route and canonical event snapshot route respond, the EventScheduler and completed-event expiration alarm have been validated, and the Chondl Statbotics integration has been verified end-to-end for `2026cthar` (89 matches fetched and represented in the canonical snapshot with Statbotics enrichment and independent source provenance). This is local prototype validation only; no Cloudflare deployment, production secret configuration, scheduler activation, or production cutover has occurred.
