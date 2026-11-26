# FieldView Agent Instructions

## Project and migration status

FieldView is a data application for FIRST Robotics Competition. Its web application presents live event information, team/event history, remote display sessions, and server-calculated analytics.

The repository is undergoing an owner-approved **retire-first, rebuild-cleanly architecture migration** on branch `fieldview-architecture-migration`. The current Next.js/Vercel/Redis/SharedWorker implementation is legacy, not the target architecture. Existing FieldView functionality may temporarily break on this branch; do not preserve obsolete implementations solely for compatibility. Preserve canonical domain contracts, provider packages, analytics semantics, EventRuntime/TeamRuntime, the Multiplexer, architectural knowledge, and platform-required migration history. Rebuild capabilities against the target architecture. This strategy does not authorize merging to `main`, production cutover, or deletion/reconfiguration of deployed infrastructure. See `docs/architecture/RETIREMENT-AUDIT.md`.

## Confirmed target decisions

- Monorepo: npm workspaces.
- Frontend: retain Next.js.
- Migration: owner-approved retire-first/rebuild-cleanly. Temporary functionality loss on this branch is acceptable; do not retain obsolete compatibility paths solely to preserve the legacy application. Keep platform-required historical migration records.
- Backend: hybrid Cloudflare Workers and Durable Objects.
- Runtime ownership: one EventRuntime per event and one TeamRuntime per team. They are the same runtime abstraction at different data scopes and must implement the same lifecycle, refresh-command, acquisition, reconciliation, persistence, retry, and publication contract. Durable Object alarms are entirely unused by the application: do not define `alarm()` handlers or call `setAlarm()` / `deleteAlarm()`. Leave alarm behavior to platform defaults. Use explicit coordinator dispatch and intentionally started Workflows. One polling coordinator in the consolidated FieldView Worker deployment selects eligible runtime identities and directly dispatches bounded refresh commands. Runtimes fetch and reconcile their own provider resources; the coordinator never acts as a provider proxy. Direct bounded dispatch is the default; do not introduce a Queue unless measured throughput, backpressure, or reliability needs justify it. Deploy one environment-neutral Runtime Worker named `runtime`. Production uses the top-level Wrangler configuration; branch and pull-request testing uses Cloudflare Workers Previews under that same Worker, configured through the Wrangler `previews` block. Do not create Wrangler named environments or separate Workers for preview, preproduction, staging, or production. Durable Object namespaces are isolated automatically per Preview. Cloudflare does not currently provision isolated Workflow instances per Preview; do not bind Previews to production Workflows, and document any Preview limitation until a dedicated non-production Workflow strategy is implemented. The modular entrypoint exposes the HTTP API, webhooks, Durable Object classes, coordinator, and Workflow classes.
- Domain and analytics packages must be reusable independently of Next.js and Cloudflare. The domain may use provider packages as type-only dependencies for unchanged provider-sourced fields; it must not depend on provider clients or transport at runtime.
- Provider-independent FieldView domain contracts are the only data contracts the frontend should consume.
- The migration branch has Vercel preview deployments intentionally skipped through the project's Ignored Build Step. Do not remove or override this branch-specific setting in repository work.

See `docs/architecture/MIGRATION-PLAN.md` and `docs/architecture/MIGRATION-INVENTORY.md` for phase sequencing and known legacy mappings, ADR-0019 for the single-Worker-with-branch-Previews deployment decision, ADR-0018 for publication-gated reads, `docs/architecture/decisions/2026-11-24-storage-and-polling-ownership.md` for runtime/polling/storage ownership, and `docs/architecture/decisions/2026-11-24-alarm-usage-policy.md` for the last-resort-only alarm policy. ADR-0014 is historical and superseded.

## Non-negotiable product and data principles

1. **FieldView owns its domain model.** External APIs are inputs, not the application's public data model.
2. Pass provider payloads unchanged into FieldView domain normalization. Preserve provider field names, values, types, nullability, and structures. Provider schemas remain in provider packages; the backend domain may use their types for pass-through fields.
3. Keep acquisition, normalization, domain state/reconciliation, derivation, and presentation as distinct responsibilities.
4. Preserve provenance and freshness internally. Distinguish unavailable/missing data, explicit null/clear, zero, stale values, and failed acquisition.
5. A failed or partial provider request must not erase unrelated valid state. A successful explicit clear may clear the corresponding prior value.
6. Define source precedence per field. Do not let request timing or incidental merge order decide which source wins.
7. Build data capabilities once and make them reusable across web pages, live surfaces, remote displays, and future consumers.
8. Server-side calculations are authoritative. Presentation components must not independently reproduce analytics or fetch providers.
9. Do not claim a public developer API, production Cloudflare runtime, Durable Object, or completed migration until it exists and has been validated.

## Target repository boundaries

The planned npm workspace layout is:

- `apps/web` — Next.js application, pages, UI, and web-specific route adapters.
- `workers/fieldview` — the single Cloudflare Worker project, with `src/runtime` and `src/jobs` modules, one `wrangler.toml`, one local `.dev.vars`, and one entrypoint.
- `packages/domain` — canonical FieldView domain objects, FieldView normalization/correlation, and domain rules.
- `packages/contracts` — versioned serializable client-facing DTOs and validation schemas.
- `packages/providers/*` — isolated provider clients, raw provider types, validation, normalization, retries, rate limits, and source metadata.
- `packages/analytics` — declarative metric definitions and a small provider/UI-independent calculation engine.
- `packages/config` or root configuration — shared TypeScript/lint/tooling only when reuse justifies it.

This is a target boundary map, not permission to move every existing folder mechanically. Keep changes small, trace imports, and validate the build after each structural step. Do not create placeholder packages without a concrete first consumer.

## Provider adapter boundary
### Provider package ownership

Each external provider has one self-contained package under `packages/providers/<provider>/`.

Everything specific to that provider belongs in that package:
- generated OpenAPI types and raw provider schemas;
- schema-generation scripts, configuration, and supporting files;
- provider API clients and service layers;
- provider-specific validation and response types;
- provider-specific request, retry, rate-limit, and freshness behavior.

Do not split generated schemas, clients, services, or normalization into separate generic packages. Do not put provider-owned implementation or generated types in `apps/web` or `packages/domain`.

The domain may depend on provider packages for types only. It must not import provider clients, service implementations, or transport code. Client contracts must not import or expose provider types.

Provider packages own:
- API transport, credentials, provider-specific request/response types, and generated schemas;
- retry, backoff, rate limiting, and provider-specific request behavior;
- unchanged provider payload delivery to the FieldView domain normalization layer.

FieldView domain normalization owns cross-provider correlation, associations, and explicitly approved transformations. Analytics calculations remain in the analytics layer. Provenance and freshness are maintained by backend acquisition/orchestration and associated with domain state.

Provider packages must not expose raw provider response objects directly to the frontend or published client DTOs. The backend domain may use provider types to preserve source values. Do not leak names such as `TBAEvent`, `TBAMatch`, `StatboticsMatch`, provider status enums, or provider response envelopes into client-facing contracts.

Provider packages do not normalize, correlate, aggregate, or calculate FieldView values. They deliver unchanged provider payloads to the FieldView domain. The domain owns canonical model construction, cross-source associations, and explicitly approved transformations; analytics calculations remain in the analytics layer. Preserve field-level source precedence and partial-failure semantics.

Statbotics runtime data should use the official API (`https://api.statbotics.io`) when it is operational. The official service is currently unavailable; retain the configured testing mirror `https://api-statbotics.iterativerefinement.com/` until the official API is restored or a FieldView-operated compatible service is available. Do not silently replace this working testing endpoint. Keep the endpoint configurable and identify the active source in runtime provenance.

## Data ownership, normalization, and cross-runtime references
Relational SQLite tables must satisfy 1NF and 2NF at minimum: non-key attributes depend on the whole candidate key, not only part of a composite key. Use 3NF where transitive dependencies would duplicate facts. Durable Object storage currently uses per-object key/value records, so enforce the equivalent domain rule through single ownership and logical foreign references rather than inventing cross-object SQLite foreign keys.


Canonical data has exactly one owning runtime and one authoritative persisted representation. This is a storage and contract invariant, not merely a preference for reducing payload size.

- EventRuntime owns event-scoped provider resources, FieldViewEventState, and FieldViewEventAnalytics.
- TeamRuntime owns team-scoped provider resources, FieldViewTeamState, FieldViewTeamEventState, and team-scoped analytics.
- There is no district-owned runtime, directory, snapshot, cache, acquisition, or query surface. TeamRuntime and EventRuntime retain the district membership data reported by their own team/event provider records; consumers use that local reference and never fetch a separate district record.
- EventRuntime owns event identity, event/team participation, matches, playoff alliances, and event-wide analytics. EventState may contain event-owned participation facts, but it must reference TeamRuntime-owned team profiles by team key rather than embed them.
- A match may retain its match-local alliance roster as team keys and relationship-scoped facts. It must not copy team profiles, OPR/EPA metrics owned by another aggregate, or complete playoff-alliance records; use references for canonical records and retain only match-owned or explicitly derived values.
- TeamRuntime's season history references EventRuntime-owned events by event key; it must not embed complete event records.
- A runtime must not persist a complete canonical record owned by another runtime. Cross-runtime dependencies are represented by stable references that identify the owner, owner identity, record type/identity, and the source revision where relevant.
- Because EventRuntime and TeamRuntime are separate Durable Objects with separate SQLite databases, cross-runtime references are logical foreign keys. The owner runtime validates and resolves them; no caller directly reads another runtime's SQLite storage.
- Do not duplicate provider payloads, canonical entities, match records, or complete nested aggregates across runtime boundaries. Preserve the authoritative copy at its owner.
- Data may be combined in memory only when a specific operation requires the combined input. Discard that working set when the operation completes; persist only the output owned by the calculating runtime and the minimal provenance needed to validate it.
- Consumer-facing read projections are allowed only when required by a concrete read capability. They contain minimal derived fields or references, are explicitly non-authoritative, versioned, bounded, and must not embed complete foreign canonical objects.
- Avoid unbounded nested collections in persisted cross-runtime publications. A publication must not become a second database assembled from other runtimes.
- If an existing persisted contract violates these rules, migrate readers and writers to the normalized contract and retire the duplicated representation. Splitting or chunking an unnecessarily duplicated aggregate is not an acceptable permanent fix.

## Domain model and runtime ownership

Canonical domain concepts include:
- `FieldViewTeam` and `FieldViewTeamSeason`;
- `FieldViewEvent` and `FieldViewEventTeam`;
- `FieldViewMatch` and `FieldViewPlayoffAlliance`;
- `FieldViewEventAnalytics`, `FieldViewTeamEventAnalytics`, and the canonical team/event state aggregates.

A domain object is data; a runtime is machinery that acquires, reconciles, persists, and publishes data. Do not create a Durable Object for every interface or DTO.

The execution/orchestration boundary is strict and symmetric. EventRuntime and TeamRuntime implement one shared runtime contract at different scopes: each accepts explicit refresh commands, owns its provider requests and validators, reconciles its own data, persists its own canonical state, manages scope-local retry/backoff, and publishes its own versioned outputs. Do not create two different polling or persistence models for the two runtime types. The polling coordinator is responsible for lifecycle eligibility, target selection, bounded concurrency, overlap prevention, prioritization, and aggregate budgets; it dispatches commands directly and does not fetch provider data or construct deltas. Workflows own durable cross-runtime orchestration, runtime initialization, season ingestion, and manual team/event seeding. Discovery owns discovery data; System Records owns workflow and operational records; Durable Objects own canonical runtime state. A Queue is not part of the default refresh path.

Use one event-scoped EventRuntime per event and one team-scoped TeamRuntime per team. They are the same runtime abstraction at different data scopes. EventRuntime owns canonical event data and event-wide analytics; TeamRuntime owns canonical team/season data, team-specific event state, and team-scoped analytics. TeamRuntime tracks events in which its team is participating. EventRuntime must not directly invoke TeamRuntime to collect analytics inputs, and TeamRuntime must not directly invoke EventRuntime to notify changes. The polling coordinator or a dedicated durable Workflow selects the required cross-runtime targets, reads versioned inputs through explicit interfaces, and dispatches bounded commands. Each runtime executes only its own provider acquisition, reconciliation, persistence, retry, and publication. EventRuntime must not embed complete TeamEventState records in EventView or independently recalculate team-scoped metrics. Lifecycle transitions and roster reconciliation must be explicit durable jobs, not side effects of ordinary reads. Workflows must not perform entity-scoped provider I/O or own entity polling queues. A runtime must never call a global coordinator merely to register itself during a normal read or refresh.

**Admin job execution is always asynchronous.** An admin HTTP request validates a typed operation, creates or controls its owning Workflow, and returns an accepted/queued response (normally HTTP 202). It must not wait for provider I/O, a Workflow, or another Durable Object to finish its work. Workflows advance cross-runtime jobs through durable steps, retries, and sleeps; EventRuntime and TeamRuntime execute the same direct refresh command against their own scope. The coordinator bounds dispatch and no runtime-local queue/alarm is the default refresh mechanism. Admin status endpoints read durable Workflow/job state from DiscoveryStore and Cloudflare Workflow instances, and the dashboard polls that state without holding a global busy lock for the job's lifetime. Stopping routine polling must not cancel or strand already accepted admin jobs.

Maintain one authoritative writer for each state resource. Discovery owns only system-wide TBA season/event/team directory discovery; System Records owns durable workflow, administrative, and operational records; EventRuntime owns event-scoped TBA/Statbotics resources; TeamRuntime owns team-scoped TBA/Statbotics/FRC-Colors resources. Neither discovery nor one runtime may acquire resources owned by another scope. Both runtime types issue their own provider requests through the shared refresh contract. The polling coordinator directly dispatches bounded refresh commands to EventRuntime and affected TeamRuntime instances; do not add per-runtime provider queues/alarms or a Queue-based batching layer as the default design. Separate Durable Objects may execute independently; do not add a global provider-request lease or mutex. Persist each resource's ETag and cached representation indefinitely; freshness expiration triggers revalidation and must never be treated as a storage TTL. TeamRuntime persists a possibly partial FieldViewTeamState, per-event FieldViewTeamEventState, and FieldViewTeamEventAnalytics. EventRuntime persists FieldViewEventState and FieldViewEventAnalytics. Publish versioned, data-bearing FieldView DTO changes with explicit ordering/reconnect semantics; do not make clients reconstruct authoritative state from incidental provider events. The browser SharedWorker is the single synchronization owner per origin and persists canonical DTOs plus ETags in IndexedDB. Tabs consume its cache and updates rather than opening independent runtime connections or issuing duplicate reads. ETags validate representations; resource revisions order live changes. A revision gap, incomplete cache, or schema mismatch requires conditional HTTP recovery. See ADR-0013.

For event-team status, preserve the distinction between match freshness and team-status freshness. The TBA full-event status dataset is a coherent source for event team status; targeted refresh versus periodic full reconciliation remains a documented design decision until endpoint availability/cost and invalidation behavior are verified. Successful explicit null clears; failed fetches do not clear prior valid state. Derive user-facing summaries from structured normalized fields rather than provider HTML strings.

## Analytics architecture

Analytics must be easy to inspect, explain, test, and modify.

- Analytics ownership follows scope: TeamRuntime owns team and team-event calculations; EventRuntime owns event-wide calculations and aggregation over participating TeamRuntime results.
- EventAnalyticsWorkflow reads EventRuntime's versioned event input and the registered TeamRuntime owners' versioned team-season inputs, builds one shared FieldViewEventTeamSeasonComparisonInput, and dispatches it to the affected TeamRuntimes. TeamRuntime combines that input with its own authoritative season state, calculates and persists only its own FieldViewTeamEventAnalytics / FieldViewTeamEventState. Neither runtime independently orchestrates the cross-runtime comparison population.
- Ordinary TBA webhook delivery is event-scoped at Worker ingress: the authenticated original payload is dispatched only to EventRuntime, which owns canonical event resources and match projections. After EventRuntime accepts the webhook, Worker ingress starts the durable EventAnalyticsWorkflow; that Workflow resolves registered TeamRuntime owners, supplies the shared versioned comparison input, and dispatches team-event analytics commands. TeamRuntime is not a webhook receiver and must not duplicate canonical event-owned provider resources. The Workflow, not EventRuntime, owns cross-runtime analytics orchestration.
- FieldViewEventView contains event-owned state and analytics plus participant references and explicit coverage metadata; it never embeds complete TeamRuntime-owned TeamEventState records. Roster reconciliation runs as an explicit durable job, not as a side effect of ordinary event reads.
- Every generated model uses the FieldView prefix. Provider-originated models retain their provider prefix (TBA, Statbotics, FRCColors). Canonical names include FieldViewTeamState (team/season), FieldViewTeamEventState (team/event), FieldViewTeamEventAnalytics (team/event analytics), and FieldViewEventAnalytics (event analytics).

- Metric definitions declare inputs, operation, output semantics/unit, scope, version, and relevant interpretation/limitations.
- A small generic engine resolves supplied inputs, validates them, and executes a registered vocabulary of safe operations.
- Do not use `eval()`, arbitrary expression strings, or provider/UI-specific code in the engine.
- Complex metrics compose known operations rather than introducing hidden bespoke execution paths.
- Support both per-object and collection/event-wide calculations. Collection results must expose eligible population and sample size.
- Keep calculation, comparison/classification, human-readable interpretation, and UI rendering separate.
- Do not fetch providers from the engine. Inputs are passed in by orchestration.
- Keep missing, null, and zero distinct; version definitions so historical results can be compared deliberately.

Analytics conclusions are descriptive evidence, not causal determinations. Alliance residuals, shared model updates, win-probability mismatches, and partner patterns must not be attributed to an individual robot. Review flags invite a human scout to investigate.

For event-wide team change comparisons, compare each team against its own most recent prior official event. Include all target-event teams in event views, but rank only teams with usable prior/current data. Do not require a shared prior event and do not silently fall back to an older event when the most recent prior event lacks usable data. Show eligible comparison coverage. See `docs/ANALYTICS-REDESIGN.md`.

## Event time

**All event-related dates, times, and datetimes displayed by the application must use that event's IANA timezone.**

- Do not display event dates/times in the viewer's browser timezone or silently fall back to browser-local formatting.
- In multi-event views, format each event using its own timezone.
- Countdown values are relative durations and do not require a timezone conversion in the display.
- Use the event timezone consistently for schedules, match times, timestamps, date labels, and event comparisons.

The goal is consistency with the venue and announcers.

## Frontend, live views, and remote sessions

The frontend consumes versioned FieldView DTOs and presentation state; it does not own provider acquisition or canonical reconciliation.

Preserve these product semantics during migration:
- Match presentation uses red/blue alliance identity only in match context. A team in `dq_team_keys` is displayed with a strikethrough in that match.
- Preserve established next/last match semantics and stale-response protection until an explicitly validated replacement exists.
- Keep remote-session controller authority and display clients separate. Remote actions must use the same controller path as local actions.
- Keep content/data, stable tile identity, priority, layout, and highlight as separate concepts. Never reorder stable streams merely to change priority.
- TileSurface is a deliberately dark-only broadcast surface; retain restrained FieldView purple accents and semantic alliance colors.
- Do not reintroduce Nexus unless explicitly requested.

The legacy browser EventState acquisition path, Redis Pub/Sub, Vercel WebSocket bridge, and legacy API routes are delivery/acquisition mechanisms being retired. Preserve them only while required for the incremental transition. The replacement canonical SharedWorker transport is the target browser synchronization path: it consumes scoped data-bearing runtime publications, maintains an IndexedDB-backed DTO cache, and uses HTTP ETags for recovery. Do not treat legacy provider-shaped snapshots as canonical; introduce compatibility mapping at the boundary.

## Existing legacy system — migration reference only

The current implementation includes:
- one Next.js application rooted at the repository root;
- 22 API route handlers at the time of the initial audit;
- Redis-backed TBA/Statbotics/FRC Colors caches and analytics job records;
- TBA webhook ingress, Redis Pub/Sub, and `/api/ws`;
- browser SharedWorker/EventState acquisition and reconciliation;
- server-side insights calculations and progressive collection;
- Vercel deployment/runtime integration.

Known legacy paths include `src/lib/tba`, `src/lib/statbotics`, `src/lib/frc-colors`, `src/lib/cache`, `src/lib/realtime`, `src/lib/events`, and `src/lib/insights`. These are migration sources, not mandatory target locations.

Never copy legacy implementation rules into new packages merely for parity. Preserve user-visible behavior and correctness, not obsolete infrastructure choices.

## Workspace and tooling rules

- Use npm workspaces; do not introduce another package manager.
- Keep Next.js as the web framework.
- Keep root scripts explicit and delegate app-specific scripts to the relevant workspace.
- Use the repository's pinned Node/npm compatibility and lockfile consistently. Do not silently regenerate or replace the lockfile with another package manager.
- Keep generated provider types generated; do not hand-edit generated output.
- Do not add Cloudflare resources or deploy backend infrastructure until local contracts, bindings, and runtime responsibilities are defined and validated.
- Do not relocate the Next.js app until current build configuration, environment dependencies, and import aliases have been mapped.
- Do not make production changes or cut over traffic as part of a structural migration step.

## Environment and secrets

Never commit secrets or real environment values. Document variable names, purpose, scope, and migration destination; use placeholders in examples. Separate browser-exposed `NEXT_PUBLIC_*` configuration from server-only credentials. Do not copy Vercel-specific secrets into Cloudflare without defining their use, access policy, and rotation.

**Keep frontend and Worker local environment configuration separate.** The Worker uses the single Git-ignored `workers/fieldview/.dev.vars`, loaded automatically by Wrangler. Frontend/Vercel environment variables remain frontend-managed and must not be sourced into the Worker process. Do not merge both sets into one shared environment file. Cloudflare-hosted environments continue to use their own independently configured secrets and variables; the root file is local development only.

Cloudflare environment selection is branch-determined and documented in `docs/development/CLOUDFLARE-ENVIRONMENTS.md`:
- **Target:** exactly one Worker per environment: `runtime-preprod` and `runtime-production`, configured by `workers/fieldview/wrangler.toml`.
- Runtime and Jobs source modules live under `workers/fieldview/src/runtime` and `workers/fieldview/src/jobs`; tests live under `workers/fieldview/test/runtime` and `workers/fieldview/test/jobs`. They are not separately deployed Workers and have no independent Wrangler configurations.
- Preproduction and Production must have separate Durable Object namespaces, Workflow bindings/instances, secrets, variables, and data.
- Do not add branch-detection logic to application code, deploy automatically from CI, or change Vercel settings as part of this migration slice without explicit approval.
- Production deployment is blocked until the temporary `RUNTIME_ADMIN_TOKEN` bearer authorization is replaced by the approved system-administrator authorization design. Never configure the testing token as a production secret.

Current legacy environment variables identified during the initial source scan include:
- `TBA_API_KEY`
- `TBA_WEBHOOK_TOKEN`
- `REDIS_URL`
- `STATBOTICS_API_BASE_URL`
- `STATBOTICS_OPENAPI_URL`
- `NEXT_PUBLIC_DOMAIN`
- `NEXT_PUBLIC_REMOTE_WEBSOCKET_URL`

This list is provisional; re-scan the source and deployment settings before changing runtime configuration. Never print or expose secret values.

## Design system and accessibility

- Follow `docs/COLOR-SYSTEM.md`. Purple is FieldView branding; red/blue are reserved for alliance identity in match context; gold/greens are metric percentile tiers; orange is a human-review indicator; team colors are provider metadata.
- Do not use generic blue utility colors for product branding, navigation, links, selection, or focus.
- Centralize non-Tailwind design values in semantic CSS custom properties. Use Tailwind for standard layout/styling where appropriate.
- Site link hover/focus uses FieldView purple. Preserve accessible focus states and semantic controls.

## Code quality and change discipline

- Search for and reuse existing helpers before adding new logic. Use `src/lib/time` for legacy date/time behavior until migrated.
- Keep route handlers thin; business logic belongs in reusable services/packages.
- Keep provider acquisition out of presentation components.
- Avoid broad unrelated refactors, dead-file cleanup, or visual changes during architecture work.
- Before deleting a file, search repository-wide for imports and callers and confirm no live use remains.
- Prefer small, focused commits with a clear purpose. Keep the branch buildable after each migration slice.
- Update README and architecture docs when behavior or ownership changes materially.
- Never modify `main` as part of this migration. Work on `fieldview-architecture-migration` unless the user explicitly changes scope.

## Agent documentation

`CLAUDE.md` must remain the one-line pointer `@AGENTS.md` so all repository agents use this source of truth.


## Runtime readiness, cache hydration, and read behavior

**Durable persistence is the readiness boundary.** A runtime with previously persisted source records and canonical publications must be able to serve its last usable data immediately after activation without provider I/O, cross-runtime fan-out, or waiting for analytics calculation.

- Public client reads are read-first and non-blocking. If a valid canonical EventState or TeamState publication exists, return the persisted publication immediately, including when stale. Public reads must not create entity runtimes, queue provider work, or wait for revalidation.
- The Worker checks the durable runtime registry before obtaining an entity stub for a public read. If no runtime marker exists, return HTTP 404 without activating the Durable Object. If the marker exists but the runtime has no persisted identity or valid canonical publication, the runtime also returns HTTP 404. Do not return an empty placeholder state or trigger initialization from the read path. The readiness Workflows inspect only runtime identities already present in the System Records registry (currently DiscoveryStore-backed during migration). They never create/activate runtimes or queue refreshes. Unregistered entities remain unavailable until an explicit registration/seed operation; the polling coordinator issues the first direct refresh.
- A failed refresh must not replace or erase the last usable publication. Until the first valid publication is generated, reads remain 404; after publication, a failed refresh leaves the last-good state readable.
- On every Durable Object activation, hydrate the runtime's in-memory indexes/cache from its own durable storage before serving requests. Use the platform-supported initialization/concurrency mechanism so requests cannot observe a half-hydrated cache. Do not make provider requests during cache hydration.
- EventRuntime hydrates only event-owned state. TeamRuntime hydrates only team-owned state. Each runtime independently manages scope-local retry state and backoff; recurring refresh timing and dispatch belong to the polling coordinator, not per-runtime alarms. Cross-runtime Workflows must not hydrate entity runtimes or become a read dependency.
- Object activation is not a global application-start event: Durable Objects are activated on demand. Therefore each activation must restore its own cache from durable storage, and system-wide invariants must be maintained by durable scheduled work rather than relying on every object starting simultaneously.
- The current season is a mandatory system invariant. System discovery must maintain durable current-season event and team directories. The separate `events-this-week` candidate projection is refreshed every Monday at 16:00 UTC and remains the candidate set through the following Sunday in event-local time; the polling coordinator re-evaluates lifecycle eligibility at every dispatch. Admins can manually rebuild the projection to handle postponements. Cloudflare does not provision isolated Workflow instances for Worker Previews: do not bind Preview deployments to the production weekly-projection Workflow; manual weekly refresh remains unavailable in Previews until a non-production Workflow strategy exists. The current season and its known entity sets must be available from persisted data immediately; discovery/reconciliation updates those indexes atomically.
- TBA `/status.current_season` is the sole authority for the current FRC season. Persist it as `discovery/current-season.json`; all current-season defaults in the frontend, APIs, admin tools, runtime dispatch, and scheduled workflows must read that value. Never infer the current season from the system/browser calendar year or assume it is the next year. Explicit year parameters remain valid for deliberate historical-season operations.
- Daily readiness resolves the TBA current season, refreshes the event and team directories, then inspects only runtimes already registered in System Records. For each registered entity it checks for a valid canonical publication and stale/missing sources and records whether a refresh is required. Unregistered discovery entries are counted but do not cause Durable Object activation. Readiness Workflows do not dispatch provider refreshes; the polling coordinator alone selects live targets and issues bounded direct refresh commands. Workflows never perform entity provider I/O.
- Runtime refresh commands use the same execution path for EventRuntime and TeamRuntime. Each runtime performs its own resource fetches sequentially or with an explicitly bounded scope-local policy; no durable per-runtime queue or alarm is required by default. The coordinator bounds cross-runtime dispatch; do not use unbounded Promise.all.
- Daily readiness runs at 10:00 UTC, before typical morning usage in the United States. It inspects coverage only and does not alter the coordinator's recurring lifecycle schedule.
- A published event view must not require synchronous fan-out to every TeamRuntime on an ordinary client GET. Cross-runtime composition and analytics are background publication work; the event runtime serves its last valid persisted view.
- Readiness must be explicit and inspectable: distinguish durable source coverage, canonical publication existence/version, in-memory hydration completion, freshness, refresh-required status, and last refresh outcome. The Cloudflare `hasStoredData` flag alone is not readiness.
- Keep the configured Statbotics testing mirror `https://api-statbotics.iterativerefinement.com/` while the official API is unavailable; preserve its source provenance.

See ADR-0015 for the read-first persistence-equals-readiness decision.


## Independent runtime readiness

- Event readiness and Team readiness are independently scoped Workflows with separate concurrency limits and progress summaries. They inspect coverage only; the polling coordinator owns refresh-command dispatch.
- Event readiness refreshes only the Event Discovery directory and inspects EventRuntime EventState coverage for registered event runtimes. It must not discover teams, create runtime registrations, or dispatch provider refreshes.
- Team readiness independently resolves TBA's canonical `current_season`, refreshes/publishes the Team Discovery directory, and inspects TeamRuntime TeamState coverage for registered teams in that season.
- Event-scoped participant resources such as `/event/{key}/teams` remain EventRuntime-owned and do not initialize TeamRuntime.
- Event analytics dependencies must be selected by the polling coordinator or a dedicated Workflow using System Records runtime registration. EventRuntime must not dispatch to or activate TeamRuntimes directly as a side effect.
- A shared external scheduler may start both Workflows, but neither Workflow depends on the other. They remain separate coverage operations and must not be used as the live polling scheduler.

## Workflow execution history

- System Records (D1) is the authoritative persistence owner for durable Workflow execution records, progress summaries, outcomes, administrative actions, and operational history. It is logically separate from Discovery even if both initially share a D1 database. Do not put operational records in DiscoveryStore or runtime canonical state.
- Each event/team readiness execution has a stable Workflow ID, a durable run record, a history index entry, a final summary, and bounded per-entity results. Keep entity results in bounded chunks rather than one unbounded JSON object.
- The admin API exposes run history and detail by Workflow ID. The dashboard may poll execution status, but it does not require incremental per-entity progress updates.
- Persist final execution status only after the summary and all result chunks are durable. If a Workflow terminates before finalization, reconcile its persisted running record against the Cloudflare Workflow instance status and expose failed/cancelled state.
- Keep high-volume diagnostic logs in platform observability; System Records are structured operational history, not a replacement for application logs.
- Do not store credentials, authorization headers, or provider secrets in execution records.

- The GitHub Actions scheduler starts the preproduction event and team readiness endpoints separately. Cloudflare Workflow bindings do not declare paid-plan cron schedules. These are readiness/discovery runs, not live polling triggers.
