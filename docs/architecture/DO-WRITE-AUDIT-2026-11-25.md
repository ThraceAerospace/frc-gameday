# Durable Object write and call-path audit

- **Status:** Source-level audit complete for the current consolidated Worker; live telemetry and Cloudflare billing reconciliation remain open.
- **Inspected branch:** `fieldview-architecture-migration`
- **Audit date:** 2026-11-25
- **Primary issue:** [#30](https://github.com/ThraceAerospace/frc-gameday/issues/30)
- **Scope:** `workers/fieldview/src/runtime`, `workers/fieldview/src/jobs`, `workers/fieldview/src/index.ts`, and `workers/fieldview/wrangler.toml`.

This is a source-level ledger, not a claim that logical storage calls equal billable SQLite row writes. Cloudflare usage telemetry was not available to this audit. The repository's former split paths named in the original issue have been consolidated under `workers/fieldview`; the findings below describe the current paths.

## Executive findings

1. **No application Durable Object currently defines an `alarm()` handler or calls `setAlarm()` / `deleteAlarm()`.** EventRuntime and TeamRuntime retain no-op `rearm()` methods; their scheduling helpers are also no-ops. The recurring owner is `PollingCoordinatorWorkflow`, started by the Runtime Worker's cron handler. There is no DO alarm lifecycle to count in the current source.
2. **No Cloudflare Queue binding or Queue producer/consumer was found.** The old `task:` and `manual:poll-queue` key names remain in EventRuntime/TeamRuntime status/diagnostic readers, but current scheduling/enqueue methods do not persist tasks. They are inert compatibility remnants, not an active DO task queue.
3. **EventRuntime still has two read-path mutation exceptions:** first-use event identity binding through `restoreEventKey()`, and one-time legacy publication sanitization in the snapshot/view publication path. The latter is conditional on a legacy-shaped record. Public reads should ultimately be read-only after initialization.
4. **TeamRuntime season analytics writes its cache on a GET even when the computed response is unchanged** (`team-runtime.ts`, around line 1033). This is the clearest repeatable read-path write amplifier.
5. **DiscoveryStore writes every generic `put`, including byte-identical values** (`discovery-store.ts`, lines 61–66 and 361–375). Current-season resolution rewrites `checkedAt` on every successful TBA status request; event-directory 304 handling rewrites both the registry list and directory metadata.
6. **Multiplexer subscription mutations are bounded and equality-guarded.** Adding a new subscription performs up to three logical puts; removing one performs up to two logical puts/deletes plus a generation update. Duplicate adds and absent removals exit without writes.
7. **Runtime admin, readiness, coverage-audit, and discovery job progress is persisted through DiscoveryStore today.** This is the main ownership violation System Records D1 is intended to remove. Workflow platform execution state is separate from these explicit application records.
8. **No telemetry-backed daily physical-row budget can be responsibly stated.** The previous 14-event scenario can be modeled after runtime traffic/DO invocation telemetry is captured, but source-only operation counts must not be presented as Cloudflare billing counts.

## Durable Object inventory

| Class | Identity / cardinality | Responsibility | Activation and callers |
|---|---|---|---|
| EventRuntime | One named object per event key | Event-owned TBA/Statbotics resources, event state, event analytics, lifecycle metadata, explicit refresh | Runtime Worker event routes; TBA webhook ingress; readiness/admin dispatch; polling coordinator; EventAnalyticsWorkflow |
| TeamRuntime | One named object per team key | Team-owned provider resources, team state/season history, team-event state and team analytics | Runtime Worker team routes; admin seeding; daily team pass; event analytics Workflow dispatch; pending-publication recovery |
| Multiplexer | One shared object per Worker environment | Browser WebSocket subscriptions and topic routing | Runtime `/stream` and subscription endpoints; EventRuntime publication notifications |
| DiscoveryStore | One shared object per Worker environment | Transitional discovery catalog and mixed operational key/value records | Runtime catalog/read/list/put routes; discovery/readiness/coverage/runtime-admin Workflows; admin dashboards; coordinator registry lookups |

Object namespaces are configured in `workers/fieldview/wrangler.toml`; Preview namespaces are isolated per Cloudflare Preview. No object-per-DTO pattern exists.

## Mutation ledger

The following counts are **logical storage API operations visible in source**, not verified physical row-write billing counts. Conditional branches and transaction batching affect the actual number of changed rows.

### EventRuntime — `workers/fieldview/src/runtime/event-runtime.ts`

| Mutation family | Trigger / call path | Keys / effects | Guard and retry behavior |
|---|---|---|---|
| Identity binding | Internal initialization and public `/snapshot`, `/view`, `/analytics`, `/statbotics-match`, `/stream`, `POST /subscriptions`, and readiness paths call identity restoration | `event-key` | Transaction checks current identity and writes only if absent. **First public read can therefore write once** if initialization was skipped. |
| Runtime subscription registration | Multiplexer-to-runtime subscription sync | Topic generation and registered flag (two keys) | Generation is written when accepted; registered flag is written on subscribe/unsubscribe. Repeated identical synchronization may still rewrite the flag. |
| Lifecycle configuration | Internal lifecycle route | `lifecycle:state`, optionally `lifecycle:completed-until`; endpoint task scheduling helpers | Lifecycle state is currently written unconditionally. Poll scheduling/cancellation helpers are no-ops; `rearm()` is a no-op. |
| Analytics enablement | Lifecycle/manual refresh/webhook routes | Analytics-enabled key | Writes only when an explicit boolean is supplied, except webhook enables analytics only if not already true. |
| Endpoint acquisition/reconciliation | Explicit refresh command from coordinator/admin/Workflow; webhook-authoritative fetch path | `endpoint:<provider endpoint>`, snapshot/source revisions, endpoint diagnostics, invalidation metadata | Transaction compares current state and applies the result. A changed representation advances revisions; 304/unchanged/failure paths have distinct metadata behavior. Retry is coordinator/Workflow-owned, not alarm-owned. |
| TBA webhook dedupe and apply | Runtime Worker webhook ingress → EventRuntime webhook route | `webhook:<id>`, affected endpoint state, snapshot revision, analytics invalidation/due/status keys | Duplicate webhook ID exits before applying the payload. Accepted changes can touch several logical keys. |
| EventState publication | Snapshot/view GET or explicit publication path | `event-state:publication` | Writes when source revision, snapshot version, or publication status differs. A legacy-shaped publication is sanitized and rewritten during read/hydration once. |
| Event analytics | EventAnalyticsWorkflow publication command / calculation path | analytics status, publication, revision, due/invalidation/error keys | Revision checks prevent stale publication. Failure and revision-conflict paths write retry/status metadata. No alarm is armed. |

**Read purity:** public EventRuntime reads are mostly read-only after initialization, but the identity binding and legacy publication sanitization exceptions above are proven. The analytics and endpoint read paths otherwise inspect durable state and build responses.

**Polling remnants:** `TASK_PREFIX` and `MANUAL_QUEUE_KEY` remain referenced by status/diagnostic reads, but `schedulePolls()`, `enqueueManualPolls()`, `ensureRecurringPolls()`, `cancelRecurringPolls()`, and `rearm()` do not persist work. No `alarm()` method exists. The coordinator directly dispatches refresh commands.

### TeamRuntime — `workers/fieldview/src/runtime/team-runtime.ts`

| Mutation family | Trigger / call path | Keys / effects | Guard and retry behavior |
|---|---|---|---|
| Identity binding | Internal initialization | `team-key` | Transaction writes only when absent. Public reads deliberately do not bind identity or run migration cleanup. |
| Provider acquisition/reconciliation | Explicit refresh/seed command from coordinator or admin Workflow | `endpoint:<provider endpoint>`, snapshot revision, endpoint diagnostics | Owner-local transaction compares and applies source result. Failed acquisition preserves prior valid data. |
| Team publication | Snapshot/publication route after provider state changes | `team-state:<year>:publication` | Transaction verifies input signature before writing. Publication is the canonical persisted TeamState record; legacy compatibility key deletion is one-time cleanup. |
| Team-event analytics | EventAnalyticsWorkflow team command | TeamEventState, its `:inputs` metadata, per-event revision, season-cache invalidation | Revision and source-input checks reject stale writes. Equal-result path avoids rewriting the state payload but may still update publication metadata when needed. |
| Publication acknowledgement | EventAnalyticsWorkflow after EventRuntime aggregate commit | TeamEventState `:inputs` publication status and season-cache invalidation | Exact revision identity required; idempotent acknowledgement; stale acknowledgements rejected. |
| Active-event membership | Internal `POST /activity` from EventRuntime/coordinator workflow | `active-events` map | Transaction writes only when membership actually changes. No recurring task is scheduled. |
| Season analytics cache | `GET /season-analytics` | `team-season-analytics:<year>` | **Writes cache with a new `checkedAt` on every successful calculation/read path**, even if inputs and response are unchanged. This is a confirmed read-path write amplifier. |

**Polling remnants:** `schedule()`, `enqueueManualPolls()`, `clearRecurringStatboticsTasks()`, and `rearm()` are no-ops. No `alarm()` handler exists. The old task/queue key names are read for diagnostics only.

### Multiplexer — `workers/fieldview/src/runtime/multiplexer.ts`

| Mutation | Trigger | Logical operations | Guard |
|---|---|---|---|
| Add subscription | WebSocket subscribe message / runtime subscription registration | Up to three puts: client subscription list, topic client list, registration generation | Duplicate subscription returns without writes. |
| Remove subscription | Unsubscribe, socket close/error cleanup, compensating rollback | Up to two puts/deletes for client/topic lists plus generation update | Missing subscription returns without writes. |
| Connect, ping, notify, state read | WebSocket lifecycle or internal notify/read route | No durable write identified | Routing state is read; notifications are sent over sockets. |

### DiscoveryStore — `workers/fieldview/src/runtime/discovery-store.ts`

| Mutation | Trigger | Logical operations / keys | Guard / amplification |
|---|---|---|---|
| Generic put | `POST /put` from jobs/admin/registry callers | One put to `discovery-object:<key>`, plus optional superseded-prefix deletes | Reads prior value but **does not compare equality**; identical values still call put. |
| Current-season resolution | Discovery/readiness Workflow catalog action → TBA `/status` | One put to `discovery/current-season.json` | Rewrites `checkedAt` on every success even if season and max page are unchanged. |
| Team page discovery | Team readiness/discovery Workflow | One put per page under `discovery/team-pages/<year>/<generation>/<page>.json` | Each generation/page is a distinct record. |
| Team directory publication | Catalog publish action | Registry teams list + team directory manifest; partial record may be deleted | Full publication writes two records and prunes prior generation pages; partial publication writes a resumable partial record. |
| Event directory discovery | Weekly projection/readiness Workflow → TBA events endpoint | On 200: staged directory + staged keys; on 304: registry list + refreshed directory metadata | 304 path still writes both records; 200 creates a new generation. |
| Event chunking/publication | Weekly projection Workflow | One put per chunk; then registry event keys + published directory; cleanup of prior chunks/staging | Chunk count is proportional to event directory size. Superseded-generation cleanup can delete many keys. |
| Weekly projection | WeeklyEventProjectionWorkflow | `projections/events-this-week/current.json` through generic put | Rewrites the projection on every successful workflow run. |
| Generic delete/prune | Superseded manifest or explicit delete route | One delete per key; prefix prune paginates up to 1,000 records per list and deletes each | Number of deletes depends on prior generation size; not transactionally atomic with new publication. |
| Generic get/list | Runtime read/admin dashboards/coordinator | No writes | Read-only. |

DiscoveryStore currently stores both discovery and operational data. Discovery-owned records are current season, event/team directory generations/pages/chunks, team/event registries, and the weekly event projection. System-owned records currently mixed into it include runtime registration markers, workflow run records/indexes/results, runtime admin job records/index/history, discovery job status, coverage audit records/items, and admin operation outcomes.

## Route and trigger matrix

| Entry point | Destination / work | Durable mutation owner |
|---|---|---|
| Runtime public event/team GETs | Resolve runtime stub; read snapshot/state/analytics | EventRuntime / TeamRuntime (with the EventRuntime first-use identity exception) |
| Runtime internal refresh/seed/lifecycle/activity | Direct bounded command to scoped runtime | EventRuntime / TeamRuntime |
| TBA webhook ingress | Verify webhook; dispatch EventRuntime; optionally start EventAnalyticsWorkflow | EventRuntime; Workflow execution state is platform-managed |
| Cron `*/5 * * * *` | Runtime Worker's scheduled handler starts PollingCoordinatorWorkflow | Coordinator dispatches EventRuntime and TeamRuntime commands; no DO alarm |
| Cron `2 4 * * *` | Same coordinator with daily team pass enabled | Coordinator dispatches TeamRuntime readiness/refresh |
| Cron `0 16 * * 1` | Starts WeeklyEventProjectionWorkflow | DiscoveryStore writes discovery and projection records |
| Weekly projection Workflow | Refresh TBA event directory, stage/chunk/publish, write weekly projection | DiscoveryStore |
| Readiness Workflows | Discovery and runtime readiness inspection; persist run/result/index records | DiscoveryStore (temporary System Records responsibility) |
| RuntimeAdminWorkflow | Seed team/event, ingest season, persist progress and outcomes | DiscoveryStore (temporary System Records responsibility) plus EventRuntime/TeamRuntime |
| CoverageAuditWorkflow | Persist audit manifest, item chunks, summary/status | DiscoveryStore (temporary System Records responsibility) |
| Runtime admin HTTP actions | Start/pause/resume/terminate jobs, update indexes/history | Workflow binding plus DiscoveryStore |
| Multiplexer WebSocket subscribe/unsubscribe/close | Maintain client/topic subscription state | Multiplexer |
| Multiplexer notify/state | Read routes and push messages | No durable write identified |

No Cloudflare Queue binding or queue operation was found. Cloudflare Workflow internal persistence is not counted as a Durable Object write. Workflow steps that call runtime routes can cause EventRuntime/TeamRuntime writes as listed above.

## Read-purity findings

| Path | Finding | Priority |
|---|---|---|
| EventRuntime public read identity restoration | May persist `event-key` on first public read if prior initialization was skipped | Medium; ensure explicit initialization precedes public access |
| EventRuntime snapshot/view publication hydration | Conditional one-time rewrite when legacy fields are found | Low; remove after legacy records are impossible |
| TeamRuntime `GET /season-analytics` | Persists refreshed cache metadata on successful GET, including cache-hit checks | High; make cache writes explicit/conditional or move cache to a read-through non-authoritative store |
| DiscoveryStore `GET /get`, `GET /list` | Read-only | Pass |
| EventRuntime/TeamRuntime ordinary state/snapshot reads | No routine provider fetch or task scheduling identified | Pass, subject to first-use and cache exceptions |
| Multiplexer state/notify | Read-only | Pass |

## Write amplification and budget

The code supports the following logical-operation estimates:

- Multiplexer new subscription: at most 3 puts; removal: up to 3 logical mutations (client list, topic list, generation), with deletes replacing puts for empty lists.
- DiscoveryStore generic put: 1 put regardless of equality, plus 0..N prune deletes.
- Team directory publication: 2 puts plus optional deletion of partial record and prior-generation pages.
- Event directory 304: 2 puts. Event directory 200: 2 staging puts, then 1 put per chunk, then 2 publication puts, plus superseded-generation cleanup.
- EventRuntime/TeamRuntime refresh and analytics costs depend on changed source representations and current revisions; transactions can include multiple key mutations. A source-level put count is not a Cloudflare physical row-write count.
- Runtime admin and readiness progress writes are proportional to workflow update/batch boundaries. The current implementation repeatedly rewrites one JSON record and may write result chunks/index/history records.

A defensible daily budget still requires: actual invocation counts per DO class; successful/unchanged/304/failed provider response distribution; subscription churn; directory sizes and generation-prune counts; workflow run frequency and step counts; and Cloudflare usage metrics for the billing period. The old 14-event workload is a scenario input, not observed traffic. Do not multiply the logical counts above and call the result billable writes.

## Prioritized findings

1. **High — TeamRuntime season analytics GET writes cache metadata.** Remove unconditional cache writes from the GET path or make them occur only on explicit refresh/mutation.
2. **High — DiscoveryStore generic put has no equality guard.** Add byte/signature equality checks before writes; avoid updating `checkedAt` when the source representation is unchanged unless freshness metadata is intentionally part of the record contract.
3. **High — operational records are stored in DiscoveryStore.** Move registrations, workflow progress/results, admin jobs/history/actions, coverage audit records/items, and operational events to System Records D1.
4. **Medium — EventRuntime first public read can bind identity.** Ensure all public runtime exposure follows explicit initialization, then remove read-time binding.
5. **Medium — EventRuntime lifecycle state is written unconditionally.** Add equality checks; retain only the metadata that is consumed by coordinator policy.
6. **Medium — directory publication and generation cleanup are multi-step and non-atomic.** D1 transactions should publish manifests and row sets atomically; staging cleanup should be bounded and retryable.
7. **Low — Multiplexer subscription writes are expected, bounded, and equality-guarded.** Measure actual connection churn before redesign.
8. **No active alarm/Queue issue in current source.** Do not add alarms or Queues to solve the original quota symptom.

## D1 schema and cutover decision

The initial schema is introduced in `workers/fieldview/migrations/0001_initial.sql`. It creates separate `discovery_*` and `system_*` table families in the same physical D1 database. This is logical schema separation, not separate SQLite attached databases. Production and Preview bind different physical D1 databases, so the same migration applies independently to each.

- Discovery tables own season metadata, team/event directory generations and members, staged pages/chunks, and the canonical weekly projection.
- System tables own runtime registration, workflow runs/progress/results, admin jobs/index/history/actions, discovery job status, coverage audits/items, and structured operational events.
- `system_records` is a temporary typed-JSON escape hatch for records not yet mapped. New code should use typed tables; never store EventRuntime/TeamRuntime canonical state here.
- Foreign keys are limited to System Records relationships within D1. Durable Object-owned records remain separate and are referenced by kind/key/revision only.
- Provider payload JSON is retained unchanged in directory rows; timestamps are Unix milliseconds.
- Retention is represented with `retention_until` / `expires_at` fields but no automatic deletion policy is enabled by this migration.

**Not yet implemented:** D1 repository adapters, dual-read/write, data migration, or replacement/removal of DiscoveryStore. The owner approved a clean-slate storage implementation, so no existing DiscoveryStore records need importing. The cutover still needs typed repository code, tests, and an explicit switch from the DO binding. No schema migration has been applied to either Cloudflare database.

## Telemetry / external verification still required

- Cloudflare usage metrics for DO SQLite row reads/writes, alarm invocations (expected zero from source), Worker invocations, Workflow steps, and D1 operations.
- Confirm billing semantics for each DO storage API/transaction against the current Cloudflare plan documentation; this audit intentionally does not infer physical row counts.
- Observe Preview and Production independently. All Previews share the test D1/KV namespaces with one another, while Production is isolated.
- Verify no out-of-repository Worker, dashboard, or automation invokes internal endpoints not found in this repository.

## Recommended implementation order

1. Add D1 repositories for Discovery and System Records against the schema migration.
2. Move operational records and runtime registration markers first; keep DiscoveryStore temporarily for catalog data.
3. Move discovery directory/projection records; use transactions for publication boundaries and equality guards.
4. Remove the DiscoveryStore binding/class only after all callers are migrated and tests prove no remaining use.
5. Separately fix TeamRuntime season analytics GET cache writes and EventRuntime read-time identity binding.
6. Compare actual Cloudflare usage before and after cutover; do not deploy or apply migrations without explicit approval.
