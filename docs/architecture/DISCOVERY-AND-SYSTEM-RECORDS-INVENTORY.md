# Discovery and System Records Storage Inventory

- **Status:** D1 implementation cutover landed; historical pre-cutover classification retained below
- **Branch:** `fieldview-architecture-migration`
- **Updated:** 2026-11-26
- **Decision:** `docs/architecture/decisions/2026-11-24-storage-and-polling-ownership.md`

This document records the current storage ownership discovered in the Worker source before introducing the separate D1 repositories. It is deliberately not a claim that the full Issue #30 mutation/call-path audit is complete. Unknown or unverified call paths remain explicit follow-up work.

## Current implementation snapshot (2026-11-26)

This section describes the live branch implementation and supersedes any present-tense wording in the historical pre-cutover inventory below.

- The former `DiscoveryStore` Durable Object class, binding, SQLite migration declaration, and RPC path have been removed.
- The consolidated Worker uses the environment-specific `DB` binding. `workers/fieldview/migrations/0001_initial.sql` defines exactly two generic JSON tables: `discovery_records` and `system_records`.
- `D1RecordStore` routes discovery/catalog keys to `DiscoveryRecordsRepository` and operational/admin/workflow/runtime-registration keys to `SystemRecordsRepository`. The in-process `DiscoveryService` owns TBA current-season and directory acquisition/publication.
- D1 upserts skip byte-identical JSON/type values. Related directory publication mutations use D1 `batch()`; superseded-generation pruning occurs after publication commits.
- D1 repository tests cover table separation, prefix/cursor listing, JSON validation, no-op writes, atomic batch publication, and rollback on batch failure.
- The D1 migration smoke test is part of `.github/workflows/ci.yml` before typechecking and workspace tests. Latest branch CI run `45862827049` passed local D1 schema verification, Next type generation, admin asset build, Wrangler deployment-bundle dry run, workspace typecheck, and all workspace tests.
- No remote D1 migration has been applied. CI now applies the committed Wrangler D1 migration against a fresh local-only database and verifies that exactly `discovery_records` and `system_records` exist. This is a clean-start schema smoke test; it does not validate remote credentials, production data, or Cloudflare billing behavior.
- A typed analytics execution repository, pre-dispatch Workflow record creation, terminal outcome recording, and bounded PollingCoordinator reconciliation/retry are implemented on `fieldview-architecture-migration`. Issue #30's audit gate is closed; Issue #32's implementation is ready for test-environment validation.
- Account-specific Cloudflare physical-row usage and daily write-budget reconciliation remain unverified; source-level operation counts must not be represented as billable-row telemetry.

## 1. Pre-cutover implementation baseline (historical)

There is currently one `DISCOVERY_STORE` Durable Object binding, implemented by `workers/fieldview/src/runtime/discovery-store.ts`. It is a SQLite-backed Durable Object KV-style catalog with generic `get`, `put`, and prefix `list` operations plus TBA catalog actions.

The Worker entrypoint exports this class and the jobs module receives the same namespace through the consolidated Worker environment. Wrangler now declares `DB` and `KV_BINDING`: production uses `fieldview-d1-prod` and `fieldview-kv-prod`, while branch Previews use the isolated `fieldview-d1-test` and `fieldview-kv-test` resources. These bindings are configured but are not yet used by a Discovery or System Records repository. No D1 migration/schema or typed repository has been implemented, and there is still no separate System Records storage boundary.

The jobs-side `createDiscoveryStoreClient` is a namespace client, not a repository abstraction: it exposes generic string-key operations and a catalog RPC. The runtime-side Worker module also has a second inline client implementation for registry writes and reads.

## 2. Record classification

| Current key family | Observed purpose | Target owner | Notes |
| --- | --- | --- | --- |
| `discovery/current-season.json` | TBA status-derived current season and max team page, including `checkedAt` | Discovery | Authoritative discovery metadata; currently rewritten on every successful status resolution. |
| `discovery/events/{year}.json` | Published TBA event directory, ETag, chunk metadata, update/check timestamps | Discovery | Canonical discovery directory. |
| `discovery/teams/{year}.json` | Published team-directory manifest and generation metadata | Discovery | Canonical discovery manifest. |
| `registry/events/{year}.json` | Event keys derived from the published event directory | Discovery | Duplicate/index representation; determine whether it is needed once relational queries exist. |
| `registry/teams/{year}.json` | Team keys derived from the published team directory | Discovery | Duplicate/index representation; determine whether it is needed once relational queries exist. |
| `discovery/team-pages/{year}/{generation}/{page}.json` | Staged successful TBA team-page results | Discovery | Generation-scoped staging; superseded generations are pruned. |
| `discovery/partial-teams/{year}/{generation}.json` | Partial team-directory publication and resumability metadata | Discovery | Contains discovery result and recovery metadata; decide whether resumability belongs in Discovery or System Records after workflow ownership review. |
| `discovery/staging/{year}/{generation}.json`, `*-keys.json` | Staged TBA event directory and key manifest | Discovery | Temporary publication staging. |
| `discovery/event-chunks/{year}/{generation}/{chunk}.json` | Chunked event-directory publication staging | Discovery | Generation-scoped; superseded chunks are pruned. |
| `projections/events/this-week/**` | Weekly candidate projection and generation chunks | Discovery | Legacy key shape; target is the single `events-this-week` projection, optionally in KV. |
| `registry/runtime-events/{event}.json` | Marker that an EventRuntime has been registered/seeded | System Records | Operational registration, not discovery. |
| `registry/runtime-teams/{team}.json` | Marker that a TeamRuntime has been registered/seeded | System Records | Operational registration, not discovery. |
| `admin/discovery-jobs/{year}.json` | Manual season discovery workflow progress and outcome | System Records | Workflow record currently written by the season discovery workflow. |
| `admin/runtime-jobs/{workflowId}.json` | Runtime admin workflow status, phase, counts, errors, and outcome | System Records | Written by RuntimeAdminWorkflow and admin request handlers. |
| `admin/coverage-audits/{year}.json` | Coverage audit progress, counts, cursor, status, and error | System Records | Audit metadata. |
| Prefix referenced by `admin/coverage-audits/{year}.json.items_prefix` | Per-item coverage audit records | System Records | Superseded prefix is pruned when the pointer changes. Exact record schema and retention need verification. |

Runtime canonical state, provider validators, endpoint state, revisions, snapshots, and Multiplexer coordination are not Discovery or System Records. They remain owned by EventRuntime, TeamRuntime, and Multiplexer Durable Objects.

## 3. Observed write paths

| Operation | Current caller / path | Current mutation | Classification |
| --- | --- | --- | --- |
| Resolve current season | DiscoveryStore catalog action `resolve-current-season` | Writes `discovery/current-season.json` after successful TBA status request | Discovery |
| Discover team page | DiscoveryStore catalog action `discover-team-page` | Writes one generation/page record | Discovery |
| Publish team directory | DiscoveryStore catalog action `publish-team-directory` | Writes team registry, team manifest, optional partial record; deletes completed partial record | Discovery |
| Discover event directory | DiscoveryStore catalog action `discover-event-directory` | Writes staging document and key manifest; 304 path currently rewrites registry and directory check timestamp | Discovery |
| Write event chunks | DiscoveryStore catalog action `write-event-chunks` | Writes each staged chunk | Discovery |
| Publish event directory | DiscoveryStore catalog action `publish-event-directory` | Writes event registry and published event directory | Discovery |
| Register runtime | Runtime Worker `registerRuntimeMarker` | Writes event/team registration marker | System Records |
| Create/update discovery job | SeasonDiscoveryWorkflowBase | Writes discovery job status/progress | System Records |
| Create/update runtime admin job | RuntimeAdminWorkflow and runtime-admin HTTP handlers | Writes runtime job status/progress/outcome | System Records |
| Update coverage audit | Coverage audit workflow | Writes audit summary and per-item records | System Records |
| Superseded-generation cleanup | DiscoveryStore `pruneSupersededRecord` | Deletes old team pages, event chunks/staging, weekly projection chunks, and old coverage-audit item prefix | Depends on the owning record family above |

All generic `put` calls currently perform a storage write even when the serialized value is unchanged. `putValue` also reads the previous value before writing so it can prune superseded records. This means the current storage API obscures the logical reason and physical write count of each mutation.

## 4. Repository boundary required

The accepted architecture requires separate interfaces and D1 schemas, even if both repositories initially use one D1 database:

- **DiscoveryRepository:** typed operations for current-season metadata, event/team directory generations, publication manifests, staging/resume state, and weekly event projection.
- **SystemRecordsRepository:** typed operations for runtime registration, workflow execution/progress/outcomes, administrative actions, and coverage audit records.
- **Runtime State:** remains in the existing per-entity Durable Objects and Multiplexer; neither repository becomes a second owner of canonical runtime state.

The current generic key/value API must not simply be renamed and carried into D1. Each record family needs a typed schema, explicit primary key, indexes justified by query patterns, update semantics, and retention policy. Staging/chunk rows should be generation-scoped and cleaned up explicitly after a successful publication or retention deadline.

No D1 binding or database identifier is configured in Wrangler today. Do not add a fabricated `database_id`, provision infrastructure, or route production traffic as part of this source-only refactor. The D1 schemas and repository adapters must be validated locally before a later, explicitly authorized infrastructure configuration/cutover.

## 5. Migration order and safety constraints

1. Finish the key/call-path inventory, including every generic `put`, `delete`, catalog mutation, HTTP admin route, workflow checkpoint, and retention cleanup.
2. Confirm the exact read/query patterns and retention requirements for every System Records family, especially coverage audit item records and workflow progress.
3. Add separate typed repository interfaces and D1 schemas. Keep Discovery and System Records logically separate even if they share a D1 database.
4. Implement and test D1 adapters with explicit no-op semantics: unchanged values must not be rewritten; reads must not mutate; update operations must be attributable to a named operation.
5. Migrate one record family at a time with idempotent, resumable migration and explicit reconciliation/count checks. Do not dual-write indefinitely.
6. Move runtime registration and all workflow/admin/coverage records to System Records; remove those responsibilities from DiscoveryStore only after replacement reads and writes are verified.
7. Move discovery directories and publication staging to DiscoveryRepository; remove the DiscoveryStore catalog RPC and generic storage API only after callers are migrated.
8. Reconcile logical mutations with Cloudflare D1/DO physical write telemetry and independently budget D1, KV, and DO usage.

No live data migration, D1 provisioning, binding change, or deployment is authorized by this inventory.

## 6. Remaining audit work

This inventory is source-backed but not exhaustive. Before closing GitHub issue #30, still enumerate and verify:

- Every call site of the jobs and runtime DiscoveryStore clients, including all admin HTTP endpoints.
- Every key written/read/listed/deleted by all workflows, not only the families identified above.
- Exact coverage audit item record keys and schemas, and whether any other dynamically constructed prefixes exist.
- Whether runtime registration markers are authoritative, reconstructible, or merely advisory.
- All cleanup and failure/retry paths, including partial team discovery and interrupted event publication.
- Read-side-effect behavior and unchanged-value writes across all remaining DOs.
- Physical row-write accounting for Durable Object SQLite and future D1 adapters.

Until those items are completed and tested, the storage migration and full mutation audit remain open.


## 7. 2026-11-25 execution-history and analytics-recovery audit extension

This extension records additional concrete call paths inspected while tracing analytics Workflow recovery. It expands the initial inventory; it does **not** close the full Issue #30 audit or authorize D1 provisioning.

### Additional System Records families found

| Key family | Read/query pattern | Write pattern | Target owner / notes |
| --- | --- | --- | --- |
| `admin/workflow-runs/{event-readiness|team-readiness}/{workflowId}/record.json` | Admin workflow-runs detail route; workflow status is reconciled against the matching Cloudflare Workflow binding | Readiness Workflow start, terminal success/failure, and admin route reconciliation | System Records. One current record per Workflow ID. |
| `admin/workflow-runs/{event-readiness|team-readiness}/{workflowId}/summary.json` | Admin detail route | Readiness Workflow finalization | System Records. Final summary is separate from run status. |
| `admin/workflow-runs/{event-readiness|team-readiness}/{workflowId}/results/{chunk}.json` | Admin detail route by requested chunk | Readiness Workflow writes bounded chunks of per-entity results (25 items per chunk) | System Records. Preserve bounded result pagination; do not collapse into one unbounded JSON record. |
| `admin/workflow-runs/index/{event-readiness|team-readiness}/{timestamp}-{workflowId}.json` | Admin history route lists by prefix, then resolves record and Cloudflare Workflow status | Readiness Workflow start/finalization and admin route reconciliation | System Records. Time-ordered history index. |
| `workflows/daily-{event-readiness|team-readiness}/{timestamp}/summary.json` | No read call found in inspected source | Readiness Workflow finalization | System Records candidate legacy summary copy; confirm whether any external consumer relies on it before retirement. |
| `admin/runtime-job-index/{operation}/{subject}.json` | Runtime-admin GET route resolves current job for an operation/subject | Runtime-admin POST route when accepting a job | System Records. Current-job pointer, not the history record itself. |
| `admin/runtime-job-history/{operation}/{subject}/{workflowId}.json` | Runtime-admin GET route lists history by operation/subject | Runtime-admin GET reconciliation and superseded-running-job handling | System Records. History snapshots; exact retention is not yet defined. |
| `admin/runtime-jobs/{workflowId}.json` | Runtime-admin GET route and RuntimeAdminWorkflow progress updates | Runtime-admin HTTP acceptance, Workflow progress, terminal success/failure | System Records. Existing per-job progress document. |
| `admin/coverage-audit-history/{year}/{workflowId}.json` | No read call found in inspected source | Coverage-audit POST when superseding a prior execution | System Records. Historical snapshot; retention is not yet defined. |
| `admin/coverage-audits/{year}.json` | Coverage-audit GET route and Workflow resume/reconciliation | CoverageAuditWorkflow progress/finalization and admin POST acceptance | System Records. Current audit pointer/summary. |
| `admin/coverage-audit-items/{year}/{workflowId}/all.json` and numbered chunk records | CoverageAuditWorkflow reads the all-items manifest and bounded chunks | CoverageAuditWorkflow writes the all-items record and chunk records | System Records. The current source writes chunks of coverage items; exact maximum and retention need a dedicated audit. |
| `registry/runtime-events/{event}.json`, `registry/runtime-teams/{team}.json` | Polling coordinator, analytics Workflow, admin inventory/entity/overview routes, and admin seeding paths | Runtime Worker registers a marker after successful event webhook acceptance or explicit runtime seeding/registration | System Records. Registration markers are operational, not discovery directories. Their authoritative/reconstructible status remains open. |

### Additional observed call paths

- Runtime Worker admin routes proxy workflow-run, discovery-job, coverage-audit, runtime-job, daily-readiness, and weekly-projection operations into the Jobs module. The corresponding read/write logic is in `workers/fieldview/src/jobs/index.ts`; route ingress is in `workers/fieldview/src/runtime/index.ts`.
- `RuntimeAdminWorkflow` in `workers/fieldview/src/jobs/runtime-admin.ts` reads and updates `admin/runtime-jobs/{workflowId}.json`; the Jobs HTTP handler creates the initial record and operation/subject index, then consults Cloudflare Workflow instance status to reconcile running jobs.
- Event/team readiness Workflows in `workers/fieldview/src/jobs/index.ts` write a running record and history index, then bounded result chunks, a final summary, a terminal record, and a final index update. The admin detail route reads the record, summary, and requested result chunk. The history route lists index entries and reconciles record status against Cloudflare Workflow status.
- Coverage audit execution writes a current record, per-item data under a workflow-specific prefix, and history snapshots when an execution is superseded. The current record's `items_prefix` is used to locate the per-item set; `DiscoveryStore.pruneSupersededRecord` currently deletes the previous prefix when the current record's pointer changes.
- Runtime registration is written in `workers/fieldview/src/runtime/index.ts` through a second, inline DiscoveryStore client implementation. It is read by the Jobs coordinator and admin routes. This is a separate call path from the Jobs-side client in `workers/fieldview/src/jobs/discovery-store.ts`.
- Discovery directory reads in runtime admin routes are mixed with System Records reads because both currently share the same generic DiscoveryStore client. Their target repository ownership must be split at the caller/interface boundary, not inferred from which helper currently performs the read.

### Analytics Workflow execution gap

The EventAnalyticsWorkflow currently has no durable System Records execution record. Its execution identity exists in the Cloudflare Workflow instance ID; bounded child retries use a stable retry key/attempt; EventAnalyticsWorkflow reads EventRuntime and TeamRuntime inputs, calculates team results, publishes the EventRuntime aggregate, and acknowledges TeamRuntime results. TeamRuntime's `publication_status=pending` records provide recovery evidence only after a team calculation has persisted. They do not cover failures before the first TeamRuntime write, including event-input/season-input acquisition failures, registration lookup failures, or a Workflow that terminates before dispatching team calculations.

The polling coordinator's existing pending-TeamRuntime scan is therefore a **publication-consistency recovery mechanism**, not a complete analytics Workflow execution recovery mechanism. A separate System Records execution ledger is required to discover failed/abandoned orchestration attempts with no pending TeamRuntime result.

The eventual analytics execution record must be attributable to a stable logical execution/recovery identity and include, at minimum, event identity, Workflow instance ID, source/revision identity once known, requested/start/update/finish timestamps, attempt/recovery identity, status, bounded retry eligibility, and a sanitized terminal outcome/error classification. Do not persist credentials, authorization headers, provider secrets, raw request headers, or high-volume diagnostic logs. The record must distinguish an active Workflow from a failed/abandoned one by reconciling its durable record with Cloudflare Workflow instance status. Recovery selection must be bounded, idempotent, and rate-limited; terminal records must remain visible for administrative intervention rather than retry forever.

No schema or D1 binding is selected in this extension. Before implementation, complete the remaining call-path/retention checks below and define whether analytics execution records share the generic Workflow execution schema or require a typed subtype. Preserve the distinction between a Workflow execution record and TeamRuntime's pending publication records.

### Remaining audit work after this extension

- Inspect every remaining DiscoveryStore generic `get`, `put`, `list`, and `delete` caller, including the full catalog action switch and every admin endpoint; verify whether reads mutate storage and whether writes are no-op aware.
- Enumerate all keys and deletion paths inside DiscoveryStore, including partial-team resume, event/team staging, weekly projection generations, and coverage-audit cleanup. Confirm exact row/chunk cardinalities and retention.
- Verify every external consumer (including any admin UI/client) of the legacy `workflows/daily-*/summary.json` copies and runtime registration markers before removing or changing those records.
- Finish the authoritative-versus-reconstructible decision for runtime registration, and document how registration is created, repaired, and retired.
- Define System Records indexes, pagination, retention, and status-reconciliation semantics across readiness, runtime-admin, coverage-audit, and analytics Workflow executions.
- Complete the mutation audit for the DiscoveryStore catalog's 304 paths, unchanged-value writes, cleanup writes, and all error/retry branches.
- Only after these items are complete: select typed D1 schemas/repositories, add local D1 migrations/tests without inventing a production `database_id`, and plan an explicitly authorized infrastructure provisioning/cutover separately.


### DiscoveryStore catalog and generic API audit findings

The full catalog dispatch in `workers/fieldview/src/runtime/discovery-store.ts` currently exposes exactly seven actions:

- `resolve-current-season`: provider-backed TBA status read; persists `discovery/current-season.json` on every successful resolution, including when the season value is unchanged (the `checkedAt` timestamp changes).
- `discover-team-page`: provider-backed page read; persists one generation-scoped team-page record.
- `resume-partial-team-directory`: reads partial-directory metadata and staged team pages; no mutation on the inspected successful resume-read path.
- `publish-team-directory`: reads generation-scoped pages, writes the team registry and directory manifest, optionally writes partial-directory metadata, and deletes the completed partial record.
- `discover-event-directory`: provider-backed event-directory read; writes staging documents/key manifests on a changed response. Its HTTP 304 path still rewrites the event registry and directory record to advance check metadata, so it is not a strict storage no-op.
- `write-event-chunks`: reads staged event data and writes bounded event-directory chunks.
- `publish-event-directory`: reads staged data/chunks, writes the event registry and published directory, then relies on later superseded-generation cleanup for old staging/chunks.

The former generic HTTP record API and its R2-style object response were removed. Current callers read and write JSON records directly through `DiscoveryServiceClient`; domain catalog acquisition remains a separate in-process operation. D1 repositories own the record tables, and no Durable Object storage facade or public generic record route is exposed.

This confirms three separate mutation concerns to preserve during the future split:
1. Provider-backed discovery operations and their staged publication lifecycle belong to Discovery.
2. Workflow/admin/runtime-registration records belong to System Records D1 and are accessed through the typed in-process record client.
3. No-op semantics and cleanup must be redesigned explicitly in typed repository operations; mechanically moving the current generic API to D1 would preserve the existing hidden-write and unbounded-cleanup risks.

The runtime registration and workflow history/admin routes listed above are read through the same generic API today. The current runtime admin overview/inventory/entity handlers also combine Discovery directory reads with System Records registration-marker reads; their future adapters must query the correct repository for each record family rather than retain a single mixed client.

The analytics execution-recovery ledger must not be added as another ad hoc `admin/...` JSON key. It belongs in the typed System Records execution model, after the outstanding audit defines shared Workflow identity, status reconciliation, recovery scheduling, and retention behavior.


## 8. 2026-11-26 source-path and execution-recovery verification

This pass updates the 2026-11-25 inventory against the current branch head. It is source-level evidence only; it does not close Issue #30 or establish physical Cloudflare row-write counts.

### Runtime registration markers

- The writer is the Runtime Worker's `registerRuntimeMarker()` helper in `workers/fieldview/src/runtime/index.ts`. It writes `registry/runtime-events/{event}.json` or `registry/runtime-teams/{team}.json` through an inline DiscoveryStore client.
- Current call sites include successful event webhook acceptance, explicit event/team seed or refresh paths, and internal event/team initialization paths. The helper performs a generic put even when the marker already exists; the DiscoveryStore generic put is not no-op aware.
- Readers include the public event/team read gates, admin entity/inventory/overview routes, `PollingCoordinatorWorkflow`, `EventAnalyticsWorkflow`, readiness Workflows, and coverage audit preparation.
- These markers currently act as operational registration/initialization gates. They are not the discovery directory and they are not canonical EventRuntime/TeamRuntime state. The System Records target owner is confirmed, but whether markers are authoritative or reconstructible, their repair semantics, and their retirement policy remain open. No in-repository external consumer of their raw key shape was found beyond the Runtime Worker/Jobs modules and admin API surface.

### Workflow and coverage record consumers

- The admin web UI consumes the same-origin `/api/admin/runtime` adapter. `WorkflowRunsPanel` requests workflow history/detail and weekly projection status; `AdminOperationsDashboard` requests discovery, runtime-job, coverage-audit, inventory, and entity views. Neither component reads DiscoveryStore directly or embeds the storage key prefixes.
- `apps/web/src/app/api/admin/runtime/route.ts` maps UI query/actions to authenticated Runtime Worker admin routes. The Runtime Worker proxies Workflow and operational-record operations to `workers/fieldview/src/jobs/index.ts`; the Jobs module owns the current generic DiscoveryStore reads/writes.
- The legacy `workflows/daily-event-readiness/{timestamp}/summary.json` and `workflows/daily-team-readiness/{timestamp}/summary.json` copies have no read call in the checked-in repository tree. This is an in-repository result only; it cannot establish that no external operator tooling consumes them. Treat them as retirement candidates, not proven dead records.
- Runtime-admin GET reads the current job record and Cloudflare Workflow status. Its GET path maps status in the response but does not write the status back. Runtime-admin GET may list history records; starting/replacing jobs writes current record, subject index, and prior history snapshots.
- Readiness `GET /internal/admin/workflow-runs` is not strictly read-only: when Cloudflare Workflow status is `errored` or `terminated` while the stored record is still `running`/`queued`, the handler writes a terminal status into the record. This is a confirmed GET-side mutation in `workers/fieldview/src/jobs/index.ts`. Detail and list routes both reconcile status; the list route can write one record per affected entry. This must be redesigned as an explicit reconciliation mutation or a separately authorized/owned background operation before a pure read repository is introduced.
- Discovery-job GET and runtime-admin GET inspect Workflow status and return a mapped status without persisting the mapping in the inspected current source. Coverage-audit GET similarly reads the current record and Workflow status; pause/resume mutations occur only on POST.

### Coverage audit record shape and cleanup

- The current coverage audit creates `admin/coverage-audits/{year}.json` as the per-year current pointer/summary, plus `admin/coverage-audit-items/{year}/{workflowId}/all.json` containing the full entity-item array.
- It then writes numbered JSON chunks of up to 100 items each. The Workflow reads one chunk and dispatches at most five runtime state inspections per durable step; after each batch it rewrites the per-year audit record with cursor/count/status progress.
- When a new audit supersedes a prior `items_prefix`, `DiscoveryStore.pruneSupersededRecord()` deletes the old workflow-specific item prefix. The current record is overwritten as progress advances; no explicit time-based retention policy is present in the inspected code. Coverage-audit history snapshots are written when a prior execution is superseded, but their retention is not defined.
- This item shape and cleanup behavior are confirmed source observations. Physical row counts for chunk puts, prefix deletes, absent-key deletes, and SQLite transactions still require Cloudflare billing/telemetry verification.

### Analytics Workflow execution gap (current source verification)

- `EventAnalyticsWorkflow` uses its Cloudflare Workflow instance ID as the execution identity, reads registered team markers, acquires versioned EventRuntime/TeamRuntime inputs, publishes the event aggregate, and acknowledges TeamRuntime results. It does not create or update a durable System Records execution record.
- TeamRuntime's `publication_status=pending` records exist only after a TeamRuntime analytics calculation has persisted. They do not cover failures before that point.
- `PollingCoordinatorWorkflow` scans bounded TeamRuntime pending-publication state. That is publication-consistency recovery only; it cannot discover a failed/abandoned EventAnalyticsWorkflow that produced no pending TeamRuntime record.
- A System Records execution ledger must therefore be a separate typed record family, not an EventRuntime analytics status field, a TeamRuntime pending publication, or another ad hoc DiscoveryStore key.

### Remaining blockers before schema selection

1. Complete the remaining Issue #30 route/trigger and mutation ledger across all Durable Object classes, including Multiplexer socket close/error cleanup, all DiscoveryStore catalog failure/retry/cleanup branches, and every Workflow-to-runtime call path.
2. Resolve runtime registration marker authority/reconstruction/repair/retirement semantics.
3. Confirm all consumers or explicitly deprecate the legacy daily readiness summary copies.
4. Define retention, pagination, and status-reconciliation behavior for Workflow executions, readiness history, runtime-admin history, and coverage-audit items.
5. Verify Cloudflare's applicable physical row-write accounting and compare it with account/runtime telemetry. The available repository connection exposes source and configuration but no account usage telemetry; this item remains unverified.
6. Only after these items are complete, finalize the typed D1 schemas and local migrations.

The approved implementation follow-up is tracked in [Issue #32](https://github.com/ThraceAerospace/frc-gameday/issues/32). Issue #32 is explicitly blocked on Issue #30's schema-selection prerequisites. No schema, migration, runtime code, Wrangler configuration, or deployment was changed in this audit pass.


## 9. 2026-11-26 Cloudflare Durable Object billing semantics

Verified against Cloudflare's current official documentation (Durable Objects Pricing, last updated 2026-11-13; SQLite-backed Durable Object Storage API, last updated 2026-09-21):

- SQLite-backed Durable Object storage exposes row-based billing: Free includes 5 million rows read/day and 100,000 rows written/day; daily limits reset at 00:00 UTC.
- The SQLite-backed Durable Object KV methods `get()`, `put()`, `delete()`, and `list()` use a hidden SQLite table and are billed as rows read and rows written.
- Each `setAlarm()` is billed as one row written. Alarm invocations are separately included in the Durable Object request count.
- Deletes count as rows written. The storage API's `delete()` returns whether the key existed, but the pricing page does not explicitly say whether a delete of an absent key incurs a row write. Do not assume either outcome; retain this as an open billing question.
- Each storage API method is implicitly wrapped in a transaction. Transactions provide atomicity/isolation; they do not make a multi-key operation a single billable row. The pricing documentation says multi-key KV operations are billed as if each key were an individual operation.
- For direct SQL, Cloudflare exposes `SqlStorageCursor.rowsWritten` for the final SQL billing count, and documents that every row update of an index counts as an additional row written. The current EventRuntime, TeamRuntime, and Multiplexer persistence paths use their Durable Object SQLite storage APIs; discovery and system records use D1 repositories.

Official references:
- [Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) — storage rows, alarms, deletes, request counts.
- [SQLite-backed Durable Object Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) — hidden KV table, implicit transactions, delete return value, SQL row counters, index write amplification.

This resolves the documentation question for the general billing model and invalidates any estimate that excludes `setAlarm()` or delete operations from the SQLite row-write budget. It does **not** establish account-specific observed usage, the billable behavior of deleting an absent key, or the actual per-operation row count in the user's account. No account telemetry is available through the connected repository tools, so the telemetry comparison remains open under Issue #30.
## 10. Clean-slate operational-record policy (2026-11-26)

The former DiscoveryStore was never deployed or populated. No historical records, compatibility reads, import, backfill, or data-preserving rollback are required. The D1 repositories start empty; the policy below governs only records created by the new implementation.

### Runtime registration markers

- `registry/runtime-events/{event}.json` and `registry/runtime-teams/{team}.json` are durable existence markers, not canonical state and not discovery directories.
- A marker is created only after an explicit successful runtime initialization, seed, refresh, or accepted webhook operation has established that the corresponding runtime is usable.
- Markers do not expire automatically while the runtime is part of the current supported dataset. They are small, low-churn gates used by public reads and bounded coordinator scans.
- A missing marker is not repaired by a public GET, readiness inspection, or a speculative DO activation. Repair is explicit: an authenticated seed/refresh/registration operation must successfully initialize the runtime and then write the marker. This avoids turning reads into writes and avoids marking an uninitialized runtime as ready.
- If an operator intentionally retires an entity from FieldView, its marker may be explicitly deleted as part of that retirement operation. No automatic deletion based solely on age is permitted.

### Workflow execution and administrative history

- New analytics execution records are authoritative System Records and are retained while queued/running/recoverable.
- Terminal analytics execution records, readiness Workflow records/results, runtime-admin job history, and coverage-audit history/item chunks have a **30-day retention period after terminal completion**. Active or retry-eligible records are never expired.
- A current coverage-audit summary/pointer per season is retained until replaced by a newer audit; superseded item chunks and history snapshots follow the 30-day terminal retention period.
- Retention is implemented as explicit bounded cleanup, not read-time expiry or hidden TTL refresh. Every cleanup operation must be idempotent, bounded per coordinator run, and delete only terminal records whose `expires_at` is due.
- The legacy `workflows/daily-event-readiness/*/summary.json` and `workflows/daily-team-readiness/*/summary.json` duplicate summaries are not part of the new contract. They may be omitted from the clean-slate implementation; the current admin UI reads the `admin/workflow-runs/...` record/summary/results family instead.
- No old admin/job/history/coverage records need to be copied or retained for compatibility.

### Audit disposition

The source-level mutation/caller inventory and the Multiplexer lifecycle paths are documented. The general Durable Object billing semantics are documented, but account-specific billable usage remains unavailable through the connected Cloudflare credential (the billable-usage endpoint returned 403). This is an explicit telemetry limitation, not a reason to block the clean-slate D1 implementation or invent a row-write budget. Validate actual D1/DO usage after an explicitly authorized test deployment and dashboard/usage access.

External consumers of removed internal routes and legacy summary copies cannot be proven absent from repository inspection alone. Because the former store was never deployed and there are no records to preserve, these are treated as retired internal contracts: any future consumer must use the current Runtime Worker admin API rather than restore the removed storage routes or duplicate summary keys.
## 11. Analytics Workflow execution recovery implementation (2026-11-26)

The clean-slate EventAnalyticsWorkflow recovery slice is implemented on `fieldview-architecture-migration`:

- `workers/fieldview/src/jobs/analytics-executions.ts` provides a typed repository for `system/analytics-executions/{execution_id}.json`, routed by `D1RecordStore` into the System Records D1 table. It records stable logical identity (`event_key` + `retry_key`), Workflow instance/retry identity, affected teams, requested/start/update/completion timestamps, attempt, status, source revision, bounded result counts, retry eligibility, and sanitized error class.
- `workers/fieldview/src/runtime/index.ts` writes the execution record **before** creating a Workflow for both TBA webhook and manual refresh dispatch. If creation fails, the record is marked failed. A duplicate deterministic Workflow ID is treated idempotently when its existing instance is queued/running/paused/complete.
- `workers/fieldview/src/jobs/event-analytics.ts` records running state before input acquisition and records completed, retry-scheduled, or failed outcomes. Attempt ownership checks prevent a late parent Workflow from overwriting a newer child attempt.
- `workers/fieldview/src/jobs/polling-coordinator.ts` scans a bounded set of System Records, reconciles stale running records with Cloudflare Workflow instance status after 15 minutes, dispatches at most five recoveries per coordinator run, uses deterministic retry IDs, and caps retries at two attempts with 5-minute/15-minute failure backoff.
- Existing TeamRuntime pending-publication recovery remains separate and unchanged; it continues to repair publication acknowledgements after team results have been persisted.
- Tests cover repository lifecycle, stable retry identity, stale-attempt protection, terminal behavior, pre-dispatch record creation, coordinator recovery contracts, and duplicate webhook/retry idempotency.

CI run `45862827049` completed successfully. Its D1 migration application was local-only; Wrangler deployment packaging was a dry run. No remote D1 migration, Cloudflare resource mutation, Worker deployment, secret change, or traffic cutover occurred.

Test-environment deployment and runtime validation remain the next step. Production remains untouched.
