# FieldView Retirement Audit

- **Status:** Preliminary source-level audit
- **Branch:** `fieldview-architecture-migration`
- **Date:** 2026-11-24
- **Purpose:** Identify legacy implementations that can be retired under the owner-approved retire-first/rebuild-cleanly migration strategy.
- **Scope:** Repository source and checked-in configuration only. This document does not authorize deployment, Cloudflare resource deletion, Vercel setting changes, or production cutover.

## Strategy change

The project owner has explicitly accepted temporary breakage of existing FieldView functionality on this migration branch. The migration no longer needs to preserve the legacy application merely to maintain continuity. Preserve the target architecture, useful domain/provider/analytics work, migration history required by Cloudflare, and product/architecture knowledge. Retire legacy implementations when their ownership has moved or when the temporary loss is explicitly accepted.

This supersedes the earlier instruction to preserve a working application throughout the migration. It does not authorize deleting production resources or changing deployed environments.

## Initial classification

| Subsystem | Classification | Audit finding and treatment |
|---|---|---|
| Canonical domain models and normalization (`packages/domain`) | **KEEP** | Retain provider-independent FieldView entities, normalization, identity, provenance, and serialization rules. These are core product contracts, not legacy infrastructure. |
| Provider packages (`packages/providers/*`) | **KEEP** | Retain stateless TBA, Statbotics, and FRC Colors transport/types. Keep provider payloads unchanged until domain normalization. Do not reintroduce provider clients into the frontend. |
| Analytics engine and definitions (`packages/analytics`) | **KEEP / REBUILD** | Preserve declarative definitions, generic operations, calculation semantics, and historical parity fixtures. Rebuild orchestration and persisted input ownership around EventRuntime/TeamRuntime. |
| EventRuntime and TeamRuntime | **KEEP / REBUILD** | Preserve the shared runtime refresh contract, canonical state ownership, reconciliation, endpoint validators, persistence, and publication. Continue aligning both scopes to the same lifecycle and command model. |
| Multiplexer Durable Object | **KEEP / REBUILD** | Retain subscription/publication coordination as target architecture. Validate its protocol and client integration independently of legacy Redis/WebSocket transport. |
| Separate runtime and jobs Worker deployments | **REBUILD / CONSOLIDATE** | Checked-in configs currently define `runtime` and `fieldview-jobs` as separate Workers, while AGENTS.md and ADR-0017 specify one consolidated FieldView Worker per environment. Consolidate entrypoints/bindings/workflows before treating deployment topology as complete. |
| DiscoveryStore | **REBUILD** | It currently mixes discovery and operational responsibilities. Split Discovery and System Records into separate D1 schemas/repositories; retain only discovery directories, season/status metadata, and the weekly event candidate projection in Discovery. |
| Legacy Redis provider caches and acquisition facades in `apps/web/src/lib/{tba,statbotics,frc-colors}` | **REMOVE** | Remove after a complete caller/import scan confirms canonical runtime/provider-package ownership. Keep any thin presentation adapters that are still required; do not retain a second acquisition path. |
| Redis package and connection (`ioredis`, `apps/web/src/lib/cache/redis.ts`) | **DEFER REMOVAL** | Redis is still used by event realtime and remote-session signaling. Remove only after each transport has a validated replacement or after explicitly accepting the corresponding feature outage. Do not confuse retiring provider caches with safely removing Redis itself. |
| Legacy event WebSocket bridge (`apps/web/src/lib/realtime/websocket.ts`, `apps/web/src/app/api/ws`) | **REBUILD / REMOVE** | Replace Redis Pub/Sub and Vercel WebSocket fan-out with Worker/Multiplexer publication and subscription. Retire the old bridge after its remaining callers are removed. |
| Remote-session WebSocket/signaling (`apps/web/src/lib/remote`, `apps/web/src/app/api/remote/ws`) | **DEFER / REBUILD** | This is an independent product capability. Preserve controller authority, role exclusivity, presence/expiry, signaling, reconnect, and session isolation if the feature is retained. It must not be accidentally deleted as part of event realtime cleanup. |
| SharedWorker event acquisition/state (`apps/web/src/lib/events`) | **REMOVE / REBUILD** | Retire browser-owned acquisition and duplicate cross-tab state. Retain only the thin client subscription/cache adapter needed to consume canonical runtime publications. |
| Canonical API route handlers | **KEEP** | The inspected event/team/analytics routes already read canonical snapshots or Worker-backed data. Keep thin same-origin adapters where useful; do not replace them with provider-shaped proxies. |
| Legacy provider-shaped routes and direct provider callers | **REMOVE** | Delete only after a repository-wide caller scan. The browser must consume FieldView domain contracts, not raw provider response schemas. |
| Admin runtime command center and readiness Workflows | **KEEP / REBUILD** | Preserve operational visibility and explicit admin actions, but rebuild around the coordinator and System Records. Readiness remains inspection-only; it must not silently trigger provider refreshes. |
| Daily readiness scheduling and legacy daily projection publication | **REMOVE / REBUILD** | Replace the daily `projections/events/this-week` behavior with the canonical weekly `events-this-week` projection and coordinator-owned lifecycle scheduling. Keep the distinct readiness Workflows where their coverage purpose remains valid. |
| Old per-runtime polling queues, alarms, and scheduler classes | **REMOVE after dependency audit** | Retire legacy recurring poll paths when coordinator ownership is established or when temporary loss of automatic refresh is explicitly accepted. Preserve Cloudflare Durable Object migration history/tags required by deployed class evolution; do not delete historical migration entries to make the config look cleaner. |
| Discovery and System Records storage | **REBUILD** | Inventory every DiscoveryStore key and caller before migration. D1 schemas/repositories must be separate; KV may hold only lightweight read-heavy projections. Runtime canonical state remains in DO SQLite. |
| Frontend pages and feature components | **REBUILD / KEEP selectively** | Do not preserve every page implementation. Keep useful presentation and product behavior, but reconnect it only to canonical FieldView contracts after backend ownership is stable. |
| Vercel migration-branch ignored-build setting | **KEEP** | Preserve the existing branch-specific preview-build skip. Do not remove or override it during repository cleanup. |
| Cloudflare/Vercel deployed resources and environment configuration | **DEFER / OUT OF SCOPE** | Repository cleanup is not permission to delete deployed Workers, Durable Objects, databases, KV namespaces, secrets, routes, or Vercel settings. Any resource retirement requires a separate inventory and explicit approval. |

## First implementation sequence

1. **Freeze the target contract:** reconcile AGENTS.md and the migration plan with this approved strategy, keeping the one-Worker-per-environment decision and the 2026-11-24 ownership decision authoritative.
2. **Trace callers before deletion:** map imports and route callers for each legacy provider facade, Redis consumer, SharedWorker module, old scheduler/alarm, and compatibility endpoint.
3. **Retire duplicate provider acquisition:** remove the web-side provider clients/caches and obsolete routes once the caller scan proves they are unused or the remaining callers are intentionally being broken.
4. **Consolidate Worker topology:** combine runtime, coordinator, webhook, Durable Object, and Workflow entrypoints into the agreed single Worker deployment model. Preserve class migration history.
5. **Replace mixed storage ownership:** implement separate Discovery and System Records repositories and classify all existing DiscoveryStore records before moving or dropping them.
6. **Rebuild coordinator/lifecycle:** weekly event candidate projection, event-local eligibility, bounded direct dispatch, affected-team derivation, overlap protection, and aggregate workload budgets.
7. **Retire legacy transports:** replace event realtime and, separately, remote-session signaling before removing their Redis dependencies.
8. **Reconnect the frontend:** keep only pages and features that consume canonical FieldView contracts; temporary broken routes are acceptable during this phase.
9. **Validate from a clean baseline:** install, typecheck, test, build, inspect quota usage, and exercise failure/restart/recovery paths before any deployment or cutover.

## Guardrails

- All source changes stay on `fieldview-architecture-migration` unless the owner explicitly directs otherwise.
- Do not merge into `main`, deploy, or alter production resources without explicit approval.
- Do not remove Cloudflare migration history required to evolve deployed Durable Object classes.
- Do not remove Redis wholesale until every remaining Redis consumer is classified.
- Do not delete remote-session functionality as collateral damage from event realtime work.
- Do not carry the prototype `RUNTIME_ADMIN_TOKEN` authorization model into production.
- Keep all event date/time presentation in the event's IANA timezone.
- A temporary feature outage is acceptable; silent data corruption, ambiguous ownership, unbounded provider work, and unreviewed infrastructure deletion are not.
