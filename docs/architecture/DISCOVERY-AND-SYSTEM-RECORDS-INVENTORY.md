# Discovery and System Records Storage Inventory

- **Status:** Initial source-backed classification; implementation migration not started
- **Branch:** `fieldview-architecture-migration`
- **Updated:** 2026-11-25
- **Decision:** `docs/architecture/decisions/2026-11-24-storage-and-polling-ownership.md`

This document records the current storage ownership discovered in the Worker source before introducing the separate D1 repositories. It is deliberately not a claim that the full Issue #30 mutation/call-path audit is complete. Unknown or unverified call paths remain explicit follow-up work.

## 1. Current implementation

There is currently one `DISCOVERY_STORE` Durable Object binding, implemented by `workers/fieldview-runtime/src/discovery-store.ts`. It is a SQLite-backed Durable Object KV-style catalog with generic `get`, `put`, and prefix `list` operations plus TBA catalog actions.

The Worker entrypoint exports this class and the jobs module receives the same namespace through the consolidated Worker environment. There is no configured D1 binding, no Discovery D1 repository, no System Records D1 repository, and no separate System Records storage boundary in the current Wrangler configuration.

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
