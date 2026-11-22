# Cloudflare Workload Allocation and Background Jobs

**Status:** Proposed implementation sequence (corrected active-event boundary)  
**Branch:** `fieldview-architecture-migration`  
**Date:** 2026-11-21

## Objective

Move scheduled orchestration, broad discovery, bulk ingestion, and cross-entity coordination out of Durable Objects—ideally eliminating `TaskScheduler` entirely. Preserve active event runtime behavior inside `EventRuntime`.

The governing rules are:

> Workers and Workflows own scheduled/background work. Durable Objects own active, entity-scoped runtime state.

> An active event's TBA polling, webhook reconciliation, canonical state mutation, and live publication stay inside that event's `EventRuntime`.

`EventRuntime` is not a general-purpose job runner. Its alarms and internal scheduling are appropriate for active event lifecycle polling because polling and webhook reconciliation must serialize against the same canonical event state. Do not move that active-event loop into a Workflow or Queue.


### TBA webhook routing contract

The Worker entry point is the routing boundary for authenticated TBA webhooks. It validates the signature and payload, derives the event key, and determines the affected team keys from the message type and payload. It then dispatches the same authenticated webhook payload directly to:

- the matching `EventRuntime` for event-scoped reconciliation; and
- each affected `TeamRuntime` for team-scoped reconciliation, when the webhook identifies teams.

The external TBA contract preserves the established authentication behavior: oversized payloads receive HTTP 413, a missing HMAC signature receives HTTP 418, an unavailable webhook secret receives HTTP 500, and an invalid signature receives HTTP 401. **Only after the HMAC signature is successfully verified does the Worker immediately return HTTP 200.** It reads and authenticates the raw request body synchronously, then uses `ctx.waitUntil()` to parse the authenticated payload, select recipients, and fan out to the runtimes. Payload/recipient errors, missing runtime bindings, rejected requests, and non-2xx runtime responses are logged internally; they cannot change the already-sent 200 response.

Each Durable Object independently validates and reconciles the webhook against its own canonical state. Do not route this through TaskScheduler, a Workflow, or a Queue: the entry point performs recipient selection and background fan-out, while EventRuntime and TeamRuntime own their respective state mutations. Keep this path intact while removing TaskScheduler and extracting scheduled orchestration. Use bounded internal retries or a durable retry mechanism only if needed later; never surface dispatch failures to TBA.

## Target responsibility boundaries

| Cloudflare resource | FieldView responsibility | Do not use it for |
|---|---|---|
| Worker | Stateless HTTP entry points, provider adapters, authorization, bounded task execution | Long-lived global mutable scheduler state |
| Workflows | Durable multi-step jobs, checkpoints, retries, pause/resume, manual and scheduled runs | Canonical event/team state |
| Cron Triggers / scheduled Workflow bindings | Start recurring scheduled jobs and Workflow instances | Active event lifecycle polling |
| Queues | Buffer independent resource tasks and notification fan-out; absorb bursts | Multi-step business process state |
| EventRuntime DO | Active event lifecycle: TBA polling while active, direct webhook reconciliation, canonical event state, analytics invalidation/publication, live updates | Global discovery, season scans, cross-event orchestration, bulk ingestion |
| TeamRuntime DO | Canonical team and team-event state; entity-scoped reconciliation when required | Global team discovery, season scans, bulk ingestion, scheduled orchestration |
| Multiplexer DO | Shared live subscription coordination | Provider polling, data ingestion, or job scheduling |
| R2 | Immutable raw provider payloads, webhook archives, large ingestion artifacts and exports | Frequently mutated canonical records |
| D1 (conditional) | Queryable job catalog, audit history, operator search and relational reporting if Workflow metadata is insufficient | Replacing entity-scoped DO consistency without a demonstrated need |
| KV / Workers Cache | Read-heavy discovery projections and cacheable public responses | Strongly consistent canonical writes |
| Workers Analytics Engine | High-cardinality operational metrics for ingestion, freshness, retries and fan-out | User-facing canonical analytics calculations |

## Workflow 1: Daily event readiness

**Name:** `DailyEventReadinessWorkflow`  
**Schedule:** daily, initially `0 16 * * *` UTC (preserve the current daily cadence unless operations choose another time).

### Goal

Find every TBA event overlapping the current Monday–Sunday week, mark it as a this-week event, ensure it has an EventRuntime state, discover its participating teams, seed every participant's TeamRuntime/TeamState for the event season, and make sure a base analytics publication can be generated.

### Steps

1. **Capture run context** — persist the scheduled timestamp, run ID, and discovery year/window. Do not recompute a different date window during replay.
2. **Discover events** — query TBA event discovery for the relevant season(s), including boundary-year cases where needed. Reuse the existing event-timezone-aware Monday–Sunday classifier. Event start/end values are date-only and inclusive; evaluate the week using each event's IANA timezone.
3. **Publish this-week classification** — update the canonical discovery projection for each matching event. A rerun must repair the projection without resetting event state.
4. **Ensure EventRuntime** — address the DO by its stable event key and invoke the supported lifecycle/initialization contract. Creating a stub alone is not sufficient evidence that the event has been initialized; verify its canonical state. This workflow seeds/initializes the entity; it does not take over active polling.
5. **Discover participants** — fetch the event's TBA team list, validate it, normalize team keys, and persist the participant list or a reference to it as a Workflow step result / durable external artifact.
6. **Seed teams** — for each participant, address TeamRuntime by stable team key and invoke the idempotent seed operation for the event's season year. Ensure the canonical TeamState publication exists and that the event-season team history resource has been acquired sufficiently to support the base analytics cohort.
7. **Verify readiness** — read the EventRuntime canonical state and the required TeamRuntime state revisions. Distinguish complete, partial, unavailable, and failed data; do not label an event fully ready merely because seed requests returned HTTP 2xx. Once an event becomes active, EventRuntime owns its ongoing TBA polling and reconciles webhooks directly.
8. **Generate/verify base analytics** — request the base event analytics calculation after the minimum required team states are available. Preserve partial status and record missing teams rather than failing the entire week's event set.
9. **Publish run summary** — counts for discovered, this-week, initialized, teams seeded, analytics ready/partial/failed, and per-event errors.

### Reliability requirements

- Stable Workflow instance ID per scheduled occurrence; do not reuse IDs.
- Idempotent event and team mutations. Never overwrite a valid TeamState with an empty seed.
- Bounded concurrency for events and teams; no unbounded `Promise.all`.
- Per-event and per-team failures are isolated; one broken event must not stop unrelated events.
- Every step has an explicit timeout/retry policy; retry provider 429/5xx and transient network errors, respect `Retry-After`, and avoid retrying permanent 4xx errors.
- Large participant lists are chunked. Pass references/counts between steps rather than large payloads.
- Persist a machine-readable readiness result that the command center can inspect.

## Workflow 2: Weekly TBA current-season refresh

**Name:** `WeeklyTbaCurrentSeasonWorkflow`  
**Schedule:** weekly, Monday at 17:00 UTC initially.

### Goal

Read TBA `/status`, validate `current_season` as a four-digit year, and refresh FieldView's season-wide TBA data for that reported year. Do not infer the season from the Worker clock.

### Steps

1. Fetch TBA `/status` through the shared TBA provider client.
2. Validate the response shape and `current_season`; retain the prior known-good season if TBA returns malformed or unavailable data.
3. Compare with the last successfully processed season and record whether the year changed.
4. Refresh TBA event discovery for that season, including all pages and completeness checks.
5. Refresh team discovery for that season where the provider endpoint is season-scoped; keep the all-time team directory separate if the TBA endpoint is not season-scoped.
6. Reconcile changed event/team membership and update read-optimized discovery projections.
7. Queue follow-up EventRuntime/TeamRuntime resource refreshes in bounded batches. Do not create a single DO request containing the entire season.
8. Publish the completed season index and run summary only after discovery pages have been validated. Keep the last complete generation visible while a new generation is incomplete.

### Reliability requirements

- TBA `current_season` is the source of truth for this job's year.
- Never replace a complete discovery generation with a partial or failed scan.
- Use provider ETags and conditional requests; a 304 updates validation metadata, not the retained payload.
- Paginate explicitly and persist cursors/checkpoints.
- Avoid duplicate team/event work by stable provider keys and idempotency keys.

## Workflow 3: On-demand TBA resource ingestion

**Name:** `TbaResourceIngestionWorkflow`  
**Schedule:** none. It is triggered by an authenticated administrative request.

### Trigger contract

Provide an admin endpoint such as `POST /admin/ingestion/tba` that validates a typed request and creates a Workflow instance. The endpoint returns the instance ID and status URL immediately; it does not perform ingestion inline.

Support explicit resource scopes, for example:

- all events for a season;
- all teams for a season or selected team keys;
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

## Migration sequence

1. Add Workflow bindings/classes and the daily event-readiness workflow.
2. Move the current daily Cron Trigger off the global TaskScheduler alarm path. Initially reuse existing DO mutation contracts, then remove any orchestration-only scheduler endpoints once all callers have migrated. Do not change EventRuntime's active-event polling alarms or direct webhook reconciliation.
3. Add the weekly TBA current-season workflow and source its year from `/status`.
4. Add the unscheduled TBA resource-ingestion workflow and its authenticated create/status/control endpoints.
5. Add Queues for fan-out and durable retry of independent resource work; do not introduce them before message contracts and idempotency are defined.
6. Move large raw payload retention to R2 and replace unbounded DO source-history records with compact references/metadata plus retention.
7. Replace every global TaskScheduler responsibility—discovery, indexing, seeding orchestration, admin bulk ingestion, coverage audits, progress tracking, and recurring scheduling—with Workers/Workflows/Queues plus a suitable read model. Move the remaining read-only discovery endpoints to a Worker-backed projection. Remove the `TASK_SCHEDULER` binding, class export, routes, storage, and migration-era code once all consumers have moved. Retire TaskScheduler entirely if no genuine entity-scoped consistency requirement remains. Preserve EventRuntime's active polling and webhook path.

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

- The daily event readiness job is a Workflow with a recurring schedule and no global TaskScheduler alarm dependency.
- Active events continue polling TBA from EventRuntime and TBA webhooks continue to reconcile directly in EventRuntime; this behavior is not moved to Workflows or Queues.
- TBA webhook authentication remains synchronous with its established 413/418/500/401 responses. Only authenticated requests receive HTTP 200 immediately; payload parsing, recipient selection, and fan-out run under `ctx.waitUntil()`. Internal failures after authentication are logged and never reflected to TBA. Tests cover auth responses, immediate authenticated acknowledgement, recipient selection, multi-team fan-out, and partial dispatch failure.
- TaskScheduler is removed entirely, including its binding, export, routes, and admin operations, once replacement discovery/job APIs are live.
- Every matching event has a canonical EventRuntime state and an explicit this-week classification.
- Every discovered participant has a TeamRuntime TeamState for the event's season, or a recorded reason why it could not be seeded.
- Base analytics is generated when the minimum inputs are present and is explicitly marked partial when inputs are missing.
- The weekly job uses the validated TBA `/status.current_season` value.
- The manual ingestion job has no recurring schedule, supports arbitrary *approved resource scopes*, exposes status/control operations, and can resume after partial failure.
- Repeated runs do not duplicate state, erase valid data, or publish partial discovery as complete.
- Tests cover replay, duplicate execution, provider 304/429/5xx, malformed TBA status, partial team failures, and large paginated scopes.
