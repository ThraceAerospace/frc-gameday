# Cloudflare Workload Allocation and Background Jobs

**Status:** Historical 2026-11-22 workload proposal; superseded by the accepted 2026-11-24 storage and polling decision  
**Branch:** `fieldview-architecture-migration`  
**Date:** 2026-11-22



> **Architecture update — 2026-11-24:** This document's original implementation proposal is historical. Its split-Worker, TaskScheduler, DiscoveryStore-as-operational-store, per-runtime polling queue/alarm, and default Queue assumptions are superseded. The current authority is [the accepted storage and polling decision](decisions/2026-11-24-storage-and-polling-ownership.md), [the migration plan](MIGRATION-PLAN.md), and [the environment guide](../development/CLOUDFLARE-ENVIRONMENTS.md). The implementation details below are retained as migration history, not current instructions. Do not provision or deploy resources from the historical prerequisites in this document.

## Objective

Use one polling coordinator inside the consolidated Worker to select eligible runtime scopes and directly dispatch bounded refresh commands. Keep provider acquisition, conditional requests, reconciliation, canonical persistence, and publication inside the runtime that owns each scope. Keep Discovery, System Records, and Runtime State separate.

The governing rules are:

> The polling coordinator owns lifecycle scheduling, target selection, bounded concurrency, and aggregate budgets. EventRuntime and TeamRuntime own their respective provider acquisition, reconciliation, canonical state, and publication.

> EventRuntime and TeamRuntime are the same runtime abstraction at different data scopes. A refresh command asks the target runtime to update itself; the coordinator does not fetch provider resources or construct deltas.

A Queue is not the default dispatch mechanism. Use direct bounded dispatch unless measured throughput, backpressure, or reliability requirements justify Queue infrastructure. Per-runtime polling alarms and durable local queues are transitional and must be removed only after every trigger, retry, webhook follow-up, analytics dependency, and recovery path has an explicit replacement.


## Implemented extraction: current-season discovery and runtime initialization

The current migration slice moves TBA-status-driven current-season event/team discovery, this-week classification, EventRuntime lifecycle initialization, and this-week participant TeamRuntime seed dispatch into the jobs Worker Workflow.

### Components

- `workers/fieldview-jobs` is a separate regular Worker. The Workflow binding owns its daily `0 16 * * *` schedule directly; no top-level Worker Cron Trigger or `scheduled()` handler is needed. Workflow concurrency is capped at one so a manual run cannot overlap the scheduled run.
- `DailyEventReadinessWorkflow` first fetches TBA `/status` through the shared provider client and validates `current_season`. It discovers exactly that one season—never the Worker-clock year or adjacent/past/future seasons. The last valid TBA-reported season is persisted in R2; if TBA status is unavailable or malformed, the Workflow reuses that last-known-good season. If no valid season has ever been recorded, the run fails safely without publishing a new discovery generation.
- The Workflow stores complete current-season event and paginated team discovery documents in the shared `fieldview-discovery` R2 bucket. A TBA event-directory 304 updates `checkedAt` while retaining the last good event payload and its original `updatedAt`. It publishes event-key and team-key registries plus the successfully initialized runtime-event registry to R2 so the command-center inventory and coverage-audit views can read the new generation without writing discovery state back into TaskScheduler.
- Team discovery uses one Workflow step per TBA page and writes immutable generation-scoped R2 pages; the manifest and team-key registry publish only after all pages validate. Event discovery uses one step for the TBA-reported season and stages the complete directory. Separate bounded steps write at most ten 25-event R2 chunks per invocation before publishing the directory document, keeping subrequests below the Free-plan per-invocation limit. Classification then runs one step per 25-event chunk, keeping repeated date/timezone calculations and JSON parsing bounded. The Workflow classifies the Monday-Sunday window using each event's timezone and inclusive date-only start/end values, writes versioned per-year projections and a per-run manifest to R2, and publishes a single current-generation pointer only after all TeamRuntime seed-dispatch and EventRuntime initialization batches have completed.
- It initializes every non-expired current-season EventRuntime (upcoming, active, or still within completed-event retention) in batches of ten through a narrow service-binding endpoint on `fieldview-runtime`. Separately, it discovers participants for this-week events, deduplicates team keys, and queues TeamRuntime seeds in batches of ten. The runtime Worker reads the pointer and all versioned per-year projections before returning a complete this-week result; it does not expose a partially published generation.
- `fieldview-runtime` reads `/events/discovery`, `/events/this-week`, and `/teams/discovery` exclusively from the published R2 generation. Missing or incomplete R2 data returns an explicit 503; there is no TaskScheduler fallback. The this-week projection uses a versioned per-year snapshot set plus one generation pointer, so a failed run cannot expose a mixed partial generation. Team directory pages are immutable and the team manifest is published only after every page is validated.
- Neither Worker uses a classic Cron Trigger for this job. The native Workflow schedule starts the run. The daily Workflow now discovers only the season reported by TBA `/status`, publishes that season's paginated team directory, discovers participants for this-week events, and queues idempotent TeamRuntime seeds in bounded batches. TaskScheduler remains only for the still-unmigrated season ingestion, district operations, and manual team/event seeding jobs. Its recurring event lifecycle loop, manual season discovery, public discovery endpoints, global start/stop/run controls, runtime-owned discovery caches, and compatibility export have been removed. Manual season discovery now runs as an on-demand mode of `DailyEventReadinessWorkflow`; the job status and published directories live in R2. Season ingestion and coverage audits read those R2 directories directly. TaskScheduler's Durable Object alarm now advances only the remaining explicit administrative jobs; it is not a discovery scheduler or a fallback for public reads.

### Explicitly not included in this first slice

This extraction initializes every non-expired current-season EventRuntime, publishes current-season event/team discovery, and queues TeamRuntime seeds for the deduplicated participants of this-week events. A successful seed response means the TeamRuntime accepted durable resource work; it does **not** mean every team-season resource is ready. Team-season readiness verification, base analytics generation/verification, and replacement of TaskScheduler's remaining season-ingestion, district, and manual team/event-seeding jobs remain subsequent migrations. The TaskScheduler class and namespace binding are retained only while those active administrative responsibilities are being extracted; public discovery reads do not fall back to it.

### Deployment prerequisites

1. Create the R2 bucket named `fieldview-discovery` once in the target Cloudflare account.
2. Configure `TBA_API_KEY` on `fieldview-jobs`. Set `RUNTIME_ADMIN_TOKEN` on both Workers to the exact same value; the runtime Worker already uses this prototype token, and the jobs Worker must share it. The token mechanism must be replaced before production.
3. Deploy `fieldview-jobs` first. Its service binding targets the already-deployed `fieldview-runtime` Worker.
4. Deploy `fieldview-runtime` second. Its service binding now targets the deployed `fieldview-jobs` Worker, and its R2-backed public reads/internal initialization route become active.
5. Trigger the first run with authenticated `POST /internal/admin/daily-event-readiness` on `fieldview-runtime`, or wait for the next native Workflow schedule occurrence. Manual triggers use a deterministic ID per UTC date; a duplicate manual trigger returns HTTP 409. The Workflow concurrency limit serializes manual and schedule-created instances.
6. Confirm the Workflow summary reports event/team discovery and participant seeding outcomes, and that the runtime Worker serves all three R2-backed discovery/read routes. Missing R2 publications must return 503 rather than falling back to TaskScheduler.

The Worker configs deliberately use the same R2 bucket name. No R2 bucket identifier is embedded in source; bucket creation is an account-level deployment prerequisite.
The isolated prototype has matching `wrangler.prototype.toml` configurations for both Workers. Create `fieldview-discovery-prototype`, deploy `fieldview-jobs-prototype` first, then `fieldview-runtime-prototype`. The prototype service bindings and R2 bucket are isolated from production; the runtime prototype has no Cron Trigger. Configure the same prototype `RUNTIME_ADMIN_TOKEN` on both prototype Workers and the TBA API key on each Worker that calls TBA.


### Durable Object migration history

The historical Wrangler migration tags that created and renamed `EventScheduler` to `TaskScheduler` remain in `wrangler.toml`. These are append-only Cloudflare Durable Object namespace migration records, not a runtime class alias or compatibility path. Keep the historical tags even though the deprecated `event-scheduler.ts` source re-export and all runtime fallbacks have been removed.

### TBA webhook routing contract

The Worker entry point is the routing boundary for authenticated TBA webhooks. It validates the signature and payload, derives the event key, and determines the affected team keys from the message type and payload. It then dispatches the same authenticated webhook payload directly to:

- the matching `EventRuntime` for event-scoped reconciliation; and
- each affected `TeamRuntime` for team-scoped reconciliation, when the webhook identifies teams.

The external TBA contract preserves the established authentication behavior: oversized payloads receive HTTP 413, a missing HMAC signature receives HTTP 418, an unavailable webhook secret receives HTTP 500, and an invalid signature receives HTTP 401. **Only after the HMAC signature is successfully verified does the Worker immediately return HTTP 200.** It reads and authenticates the raw request body synchronously, then uses `ctx.waitUntil()` to parse the authenticated payload, select recipients, and fan out to the runtimes. Payload/recipient errors, missing runtime bindings, rejected requests, and non-2xx runtime responses are logged internally; they cannot change the already-sent 200 response.

Each Durable Object independently validates and reconciles the webhook against its own canonical state. Do not route this through TaskScheduler, a Workflow, or a Queue: the entry point performs recipient selection and background fan-out, while EventRuntime and TeamRuntime own their respective state mutations. Keep this path intact while removing TaskScheduler and extracting scheduled orchestration. Use bounded internal retries or a durable retry mechanism only if needed later; never surface dispatch failures to TBA.

## Current target responsibility boundaries

| Resource/domain | FieldView responsibility | Do not use it for |
|---|---|---|
| Consolidated Worker | HTTP routing, webhook ingress, authorization, polling coordinator, bounded direct dispatch, Workflow entrypoints | Canonical event/team state or provider proxying for entity runtimes |
| Polling coordinator | Event-local lifecycle eligibility, affected-runtime selection, overlap prevention, bounded concurrency, prioritization, aggregate budgets | Provider I/O, canonical reconciliation, delta construction, general durable job history |
| EventRuntime DO | Event-scoped provider acquisition, ETags, reconciliation, canonical EventState, event publication, event-wide analytics | Team-owned provider resources, cross-runtime refresh dispatch, discovery, global scheduling |
| TeamRuntime DO | Team/season/team-event provider acquisition, ETags, reconciliation, canonical TeamState, team-scoped analytics | Event-owned matches/resources, cross-runtime refresh dispatch, discovery, global scheduling |
| Shared runtime contract | Same explicit refresh/readiness command and outcome semantics for EventRuntime and TeamRuntime | Separate polling implementations by scope |
| Workflows | Durable multi-step discovery, readiness inspection, seeding, ingestion, coverage, and admin orchestration | Entity provider I/O, local polling queues, duplicate runtime execution models |
| Discovery (D1) | Event/team directories, current-season metadata, weekly `events-this-week` candidate set, discovery refresh metadata/results | Workflow runs, runtime registration, operational history, canonical runtime state |
| System Records (D1) | Workflow execution/progress/outcomes, runtime registration, admin actions, structured operational history | Discovery directories or canonical event/team state |
| KV | Lightweight read-heavy projections such as `events-this-week` | Canonical state, locking, transactional coordination, authoritative operational records |
| Multiplexer DO | Realtime subscriptions, connection coordination, publication fan-out | Provider polling, discovery, or background job scheduling |
| R2 / object storage | Immutable raw provider payloads, webhook archives, large ingestion artifacts/exports when needed | Frequently mutated canonical records or authoritative discovery/system records |
| Queue | Optional future backpressure/retry layer only if direct dispatch proves insufficient | Default runtime refresh dispatch or canonical business-process state |

## Workflow 1: Daily event readiness

**Name:** `DailyEventReadinessWorkflow`  
**Schedule:** daily, initially `0 16 * * *` UTC (preserve the current daily cadence unless operations choose another time).

### Goal

Discover the TBA-reported current season, initialize every non-expired event's EventRuntime lifecycle, publish the current Monday–Sunday this-week projection, and seed the deduplicated TeamRuntime participants of this-week events.

### Steps

1. **Resolve the season** — call TBA `/status`, validate `current_season`, and persist the last-known-good year. If TBA is unavailable, reuse only that last-known-good year; fail safely if none exists.
2. **Publish the team directory** — allocate a replay-stable unique generation, fetch TBA team pages in 500-team pages, validate every key, write immutable R2 page objects, and publish the manifest plus team-key registry only after all pages complete.
3. **Discover and publish events** — request the event directory for exactly the TBA-reported current season, use conditional ETag validation, stage changed payloads, write 25-event chunks in bounded batches, and publish the directory/registry after the chunks are complete.
4. **Classify the season** — for each event chunk, calculate the inclusive Monday–Sunday this-week projection using the event's IANA timezone and separately classify every event's lifecycle. Exclude invalid/expired events from runtime initialization.
5. **Discover this-week participants** — fetch and validate each this-week event's TBA team list. Isolate a failed event's participant lookup so other events can continue.
6. **Dispatch TeamRuntime seeds** — deduplicate participant keys across this-week events and submit current-season TeamRuntime seed requests in batches of ten. Record accepted and failed dispatches; HTTP 202 means queued, not ready.
7. **Initialize EventRuntime** — submit every upcoming, active, or recently completed event to its canonical EventRuntime in batches of ten. EventRuntime retains ownership of active polling and webhook reconciliation.
8. **Publish the generation** — write the per-year this-week projection, manifest, runtime-event registry, and final generation pointer only after all initialization batches finish. Persist a machine-readable run summary with discovery, participant, seed, initialization, and failure counts.

### Remaining readiness work (not implemented)

9. **Verify team readiness** — read canonical TeamRuntime state and required team-season resource revisions. Distinguish complete, partial, unavailable, and failed data; do not equate a 202 seed response with readiness.
10. **Generate/verify base analytics** — request base event analytics only after minimum required team state is available. Preserve partial status and record missing teams rather than failing the entire event set.

### On-demand manual season discovery

The same `DailyEventReadinessWorkflow` binding also accepts an authenticated manual-discovery payload for an explicitly selected season. This is not a second scheduler and does not alter the daily Workflow's rule that automatic discovery uses only TBA `/status.current_season`. Manual discovery fetches that season's event directory and all 500-team TBA pages, stages event chunks and immutable team pages, and publishes the R2 event/team registries and manifests only after validation. It uses the same Workflow binding and concurrency limit as daily readiness, preventing simultaneous writers from racing on the shared directory keys. The jobs Worker exposes `POST /internal/admin/discover-year` and `GET /internal/admin/discovery-job?year=...`; the runtime Worker only authenticates and forwards these requests. Progress and final status are stored under `admin/discovery-jobs/{year}.json`. TaskScheduler does not own this job or its state.

### Reliability requirements

- Stable Workflow instance ID per scheduled occurrence; do not reuse IDs.
- Idempotent event and team mutations. Never overwrite a valid TeamState with an empty seed.
- Bounded concurrency for events and teams; no unbounded `Promise.all`.
- Per-event and per-team failures are isolated; one broken event must not stop unrelated events.
- Every step has an explicit timeout/retry policy; retry provider 429/5xx and transient network errors, respect `Retry-After`, and avoid retrying permanent 4xx errors.
- Large participant lists are chunked. Pass references/counts between steps rather than large payloads.
- Persist a machine-readable readiness result that the command center can inspect.

## Workflow 2: On-demand TBA resource ingestion

**Name:** `TbaResourceIngestionWorkflow`  
**Schedule:** none. It is triggered by an authenticated administrative request.

The daily readiness Workflow already resolves TBA `/status.current_season` and refreshes the current-season event and team directories. This on-demand Workflow is for explicit operator-selected resource ingestion, including historical seasons; it must not become a second recurring discovery scheduler.

### Trigger contract

Provide an admin endpoint such as `POST /admin/ingestion/tba` that validates a typed request and creates a Workflow instance. The endpoint returns the instance ID and status URL immediately; it does not perform ingestion inline.

Support explicit resource scopes, for example:

- all events for a selected season;
- all teams for a selected season or selected team keys;
- selected event keys and their event resources;
- selected team keys and their team resources;
- selected provider resources/endpoints for a given entity;
- a complete TBA season scan.

The request must have explicit scope and limits. Do not accept arbitrary URLs or arbitrary endpoint strings from the caller. Resolve allowed resources through the provider endpoint registry.

### Execution model

1. Validate and normalize the request; compute a stable scope fingerprint.
2. Discover the resource keys and total work count.
3. Create a durable job manifest in R2 when the manifest is large; keep only manifest reference, cursors, counts, and status in Workflow state.
4. Divide work into bounded batches and enqueue independent resource tasks where queue buffering is beneficial.
5. Workers execute provider requests with rate limiting, conditional requests, deadlines, schema validation, and retry handling.
6. Route accepted canonical mutations to the corresponding EventRuntime or TeamRuntime DO.
7. Persist per-resource outcomes and checkpoints; support pause, resume, cancel, and retry-failed operations.
8. Publish a final summary with complete/partial/failed counts and links to the detailed job record.

### Safety and operability

- Restrict to an allowlist of TBA provider resources. Do not expose an open proxy.
- Enforce maximum batch size, concurrency, total resources, payload size, and run duration.
- Make every write idempotent; assume at-least-once delivery if Queues are used.
- Keep raw provider response bodies in R2 only where archival/audit needs justify the storage; canonical state remains in DOs.
- Use an authorization design suitable for production. The current `RUNTIME_ADMIN_TOKEN` is a prototype-only mechanism and must not become the production administrator identity system.
- Retain detailed per-resource failures without storing secrets or unbounded response bodies in logs.

## Workflow 3: On-demand coverage audit

**Name:** `CoverageAuditWorkflow`  
**Schedule:** none. An authenticated admin request creates an instance; the same instance can be paused and resumed.

### Goal

Compare the published season event/team directories with the registered EventRuntime and TeamRuntime instances, then inspect their canonical state and resource/analytics coverage without making the dashboard or TaskScheduler perform a fan-out.

### Execution

1. Validate that both published R2 directories are complete and pin their `updatedAt` versions.
2. Read the per-entity runtime marker registries from R2. Missing markers are counted as missing runtimes; the audit does not instantiate empty Durable Objects just to inspect them.
3. Stage the event/team audit item list in R2 and write bounded 100-item chunks.
4. Inspect five runtime states per Workflow step through the authenticated runtime-state Worker route. Each step records resource freshness, event state, event analytics, cohort status, team snapshots, and read errors. Expired events and events with invalid dates/timezones are counted separately and are not treated as missing live runtimes.
5. Persist cursor and counters to the R2 audit record after every batch. The dashboard reads that record and the native Workflow instance status.
6. Mark the audit complete only if the published discovery versions are unchanged; otherwise mark it stale. Workflow errors are persisted and surfaced as failed.
7. Pause and resume use the native Workflow instance controls; there is no TaskScheduler alarm or "run next batch" loop.

The audit is bounded to 8,000 entities so its five-entity batch steps, 100-item staging chunks, and fixed setup/finalization steps remain below the Free-plan 3,000-steps-per-day limit. Larger inventories must be split into smaller scopes rather than silently exceeding the account budget.

### Runtime registration contract

Runtime existence is represented by immutable per-entity R2 marker objects:
- `registry/runtime-events/{eventKey}.json`
- `registry/runtime-teams/{teamKey}.json`

Workers and Workflows add markers idempotently when a runtime is successfully initialized or seeded. Per-entity keys avoid lost updates from concurrent R2 read-modify-write operations. The audit lists these prefixes; it does not use a shared mutable JSON array.

## Migration sequence

1. **Completed in this branch:** add the `fieldview-jobs` Worker and daily `DailyEventReadinessWorkflow`; discover only the TBA-reported current season; publish event and paginated team directories to R2; publish the event-timezone-aware this-week projection; initialize matching EventRuntime instances; discover event participants and queue deduplicated TeamRuntime seeds; serve public discovery exclusively from R2.
2. **Completed in this branch:** extract manual season discovery and full coverage audits into jobs Worker Workflows; publish the same R2 directory contracts used by daily discovery; remove their TaskScheduler routes, alarm loops, and processors; make season ingestion read R2 directly; and publish per-entity runtime markers so concurrent registrations cannot overwrite each other.
3. **Next:** verify TeamRuntime team-season state and event-team history readiness after seed dispatch, then generate/verify base event analytics. Preserve per-team failure isolation and do not move active event polling out of EventRuntime.
4. Extract season ingestion, district operations, and manual team/event seeding into durable Workflows with explicit manifests, checkpoints, status, and controls. Remove TaskScheduler after those active responsibilities have replacements, then remove its binding, class export, routes, storage, and obsolete migration-era source. Preserve EventRuntime's active polling and webhook path.
5. Add Queues only where independent resource fan-out or retry volume justifies them; do not introduce them before message contracts and idempotency are defined.
6. Move large raw payload retention to R2 and replace unbounded DO source-history records with compact references/metadata plus retention.

## Cloudflare Free-plan operating budget

The first extraction is designed around the Free plan rather than assuming paid-plan headroom. Recheck the Cloudflare pricing pages before production rollout because plan limits can change.

| Resource | Free-plan constraint relevant to FieldView | Design response |
|---|---|---|
| Workers | 100,000 requests/day shared with Workflow requests; 10 ms CPU per invocation; 128 MB memory; 50 subrequests per invocation | No classic Worker Cron Trigger is used for this job; the native Workflow schedule starts it. Keep bounded batches and avoid per-event Workers. |
| Workflows | 100,000 requests/day shared with Workers; 10 ms CPU per step; 3,000 steps/day; 1 GB-month Workflow storage | Three per-year discovery steps, 25-event classification steps, per-year projection publication, a final pointer, and one initialization step per ten events; step results stay compact |
| R2 | 10 GB-month storage, 1 million Class A operations/month, 10 million Class B operations/month, free egress | Store immutable year snapshots, per-run manifests, the current this-week projection, and small idempotent per-entity runtime markers; keep marker writes inside bounded batches |
| KV | 100,000 reads/day and 1,000 writes/day | Not used for the daily discovery projection; R2 is a better fit for these complete snapshot writes |
| Queues | 10,000 operations/day and 24-hour Free-plan message retention | Not required for this first slice; Workflows provide orchestration and retries |

For a run with **E** events in the TBA-reported current season, **P** pages in its TBA team directory (500 teams per page), **L** non-expired events, **N** this-week events, and **T** distinct teams participating in those events, the current Workflow uses ten fixed or conditional steps (resolve current season, allocate a replay-stable team-directory generation, publish the team-directory manifest and team registry, allocate the event-directory generation, discover the event directory, publish the event directory when changed, publish the this-week year projection, write the this-week manifest, publish the final generation pointer, and write the run summary), plus **P** team-page discovery steps, `ceil(E / 25)` classification steps, `ceil(ceil(E / 25) / 10)` event chunk-write steps when the directory changes, **N** participant-discovery steps, `ceil(L / 10)` EventRuntime initialization steps, and `ceil(T / 10)` TeamRuntime seed-dispatch steps. Team and event provider calls are bounded by page/batch size; no Workflow step sends more than ten sequential runtime initialization/seed requests. Monitor the combined total against the 3,000-step Free-plan ceiling, especially if event counts or the number of this-week participants grow. Workflow and Worker request usage is shared, so avoid multiplying this pattern into one Workflow per event.

The 10 ms CPU limit is the primary Free-plan risk, not wall-clock waiting on provider or service-binding I/O. Keep parsing and transformation bounded, avoid expensive whole-season calculations inside one step, and split work further if real execution metrics show CPU overruns. The 100,000 daily request budget is shared across the runtime and jobs Workers and Workflow activity.

## Additional Cloudflare resources recommended

### Adopt soon

- **Workflows:** primary job orchestration primitive for the three jobs above.
- **Queues:** decouple per-event/per-team resource work and notification delivery; consumers must be idempotent because delivery can be repeated.
- **R2:** store immutable provider payload archives, large manifests, and exports rather than accumulating full historical payloads inside DO storage.
- **Workers Analytics Engine:** record high-cardinality operational events such as provider status/latency, 304 rate, retries, freshness lag, queue age, failed notifications, per-workflow duration, and analytics readiness.

### Adopt when the need is demonstrated

- **D1:** useful if operators need SQL queries across workflow runs, ingestion resources, retries, audit history, or job search. Do not add it merely to duplicate Workflow instance status.
- **KV / Workers Cache:** publish read-optimized discovery indexes and public projections. Keep canonical writes in DOs and account for KV's eventual consistency.
- **Workers Builds / Previews:** use branch previews to validate Workflow bindings and isolated non-production resources before production rollout.
- **Tail Workers / Logpush:** route structured failures and execution logs to an operational sink if native Workers observability is insufficient.

### Explicitly not recommended yet

- Do not move canonical EventState or TeamState into D1 just because D1 is available.
- Do not put every scheduled or bulk job into a single global Durable Object.
- Do not use Queues as a replacement for Workflow orchestration.
- Do not add Workflows for simple synchronous reads or entity-local DO alarms.
- Do not introduce Containers, Vectorize, or Workers AI for this workload without a separate requirement.

## Acceptance criteria

- Current-season event discovery and the this-week EventRuntime initialization job run in the `fieldview-jobs` Workflow with a recurring schedule and no global TaskScheduler alarm dependency.
- The current-season event directory, current-season team directory, and this-week projection are served exclusively from the shared R2 bucket after the first successful Workflow run; missing publications return 503 and never invoke TaskScheduler.
- TeamRuntime participant seeding is dispatched by the Workflow and recorded in its summary; team-season readiness verification and base analytics readiness remain follow-on work and are not claimed as complete.
- Active events continue polling TBA from EventRuntime and TBA webhooks continue to reconcile directly in EventRuntime; this behavior is not moved to Workflows or Queues.
- TBA webhook authentication remains synchronous with its established 413/418/500/401 responses. Only authenticated requests receive HTTP 200 immediately; payload parsing, recipient selection, and fan-out run under `ctx.waitUntil()`. Internal failures after authentication are logged and never reflected to TBA. Tests cover auth responses, immediate authenticated acknowledgement, recipient selection, multi-team fan-out, and partial dispatch failure.
- TaskScheduler is removed entirely, including its binding, export, routes, and admin operations, once replacement discovery/job APIs are live.
- Every matching event has a canonical EventRuntime state and an explicit this-week classification.
- Every discovered participant is submitted to TeamRuntime for idempotent seeding, or a recorded reason why participant discovery or seed dispatch failed. A separate readiness check is required before claiming TeamState completeness.
- Base analytics is generated when the minimum inputs are present and is explicitly marked partial when inputs are missing.
- The daily Workflow uses the validated TBA `/status.current_season` value and discovers only that season.
- Manual season discovery and full coverage audits run as on-demand jobs in the jobs Worker Workflows, persist status/progress in R2, and have no TaskScheduler route or alarm dependency.
- Runtime existence is tracked by per-entity R2 markers; concurrent runtime initialization cannot lose registry entries through shared JSON-array overwrites.
- The manual ingestion job has no recurring schedule, supports arbitrary *approved resource scopes*, exposes status/control operations, and can resume after partial failure.
- Repeated runs do not duplicate state, erase valid data, or publish partial discovery as complete.
- Tests cover replay, duplicate execution, provider 304/429/5xx, malformed TBA status, partial team failures, and large paginated scopes.
