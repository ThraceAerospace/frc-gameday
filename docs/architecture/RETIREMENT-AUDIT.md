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
| Worker deployment topology | **KEEP / ALIGNED** | The target is one environment-neutral Worker named `runtime`, composed through `workers/fieldview/src/index.ts` and configured by the single `workers/fieldview/wrangler.toml`. Production uses top-level settings; branch and pull-request testing uses the same Worker's `previews` block. Do not create named Wrangler environments or separate Worker identities for preproduction, staging, or production. Any stale split Worker configuration discovered in the repository is legacy and must not be treated as an active deployment target. |
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
| Old per-runtime polling queues, alarms, and scheduler classes | **REMOVED on migration branch** | EventRuntime and TeamRuntime no longer own alarm handlers or local scheduling queues. EventRuntime's remaining lifecycle/schedule routes and no-op scheduling hooks are retired; the Worker-level coordinator selects active events and dispatches bounded refresh commands. Preserve Cloudflare Durable Object migration history/tags required by deployed class evolution; do not delete historical migration entries. |
| Discovery and System Records storage | **REBUILD** | Inventory every DiscoveryStore key and caller before migration. D1 schemas/repositories must be separate; KV may hold only lightweight read-heavy projections. Runtime canonical state remains in DO SQLite. |
| Frontend pages and feature components | **REBUILD / KEEP selectively** | Do not preserve every page implementation. Keep useful presentation and product behavior, but reconnect it only to canonical FieldView contracts after backend ownership is stable. |
| Vercel migration-branch ignored-build setting | **KEEP** | Preserve the existing branch-specific preview-build skip. Do not remove or override it during repository cleanup. |
| Cloudflare/Vercel deployed resources and environment configuration | **DEFER / OUT OF SCOPE** | Repository cleanup is not permission to delete deployed Workers, Durable Objects, databases, KV namespaces, secrets, routes, or Vercel settings. Any resource retirement requires a separate inventory and explicit approval. |

## Dependency trace findings (2026-11-24)

The following source-level dependencies were confirmed by reading the current branch files. This is not yet a complete repository-wide import graph; no source deletion is authorized by these findings alone.

- `apps/web/src/lib/cache/redis.ts` is the single shared ioredis constructor. The TBA, Statbotics, and FRC Colors legacy clients import it, as do the event WebSocket bridge and remote-session signaling server.
- `apps/web/src/lib/realtime/websocket.ts` uses Redis Pub/Sub channel `gameday:tba` for the Vercel `/api/ws` bridge. The TBA webhook compatibility route calls `broadcastTBAEvent` after Worker reconciliation succeeds, so the legacy bridge remains a live webhook side path.
- `apps/web/src/lib/remote/signalingServer.ts` uses Redis keys for exclusive controller/display presence with a 120-second TTL, refreshes presence every 30 seconds, and uses Pub/Sub for WebRTC signaling. This is an independent feature and a distinct Redis dependency.
- `apps/web/src/lib/events/workerRealtime.ts` already has a direct Worker `/stream` transport when `NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL` is configured; it falls back to the Vercel `/api/ws` bridge otherwise. The canonical snapshot/analytics subscriptions use the Worker Multiplexer. Therefore the legacy bridge is a fallback/compatibility path, not the target realtime transport.
- `apps/web/src/lib/events/sharedWorkerClient.ts` and `eventState.shared-worker.ts` multiplex both canonical runtime publications and the older `EventState` snapshot model. The old `EventState` class still contains browser-side REST loading and periodic fallback polling. The SharedWorker shell may remain useful for cross-tab subscription fan-out, but its legacy state/polling branch is a removal candidate once all UI consumers are confirmed canonical.
- `workers/fieldview/src/runtime/event-runtime.ts` and `team-runtime.ts` have no Durable Object `alarm()` handlers or runtime-owned polling queues. EventRuntime's legacy lifecycle/schedule routes, no-op scheduling methods, webhook scheduling hooks, and local Statbotics scheduling hook have been removed. RuntimeAdmin Workflows bind EventRuntime identities without starting provider acquisition. Inspection GETs no longer bind identities or write registry markers; analytics input preparation is an explicit POST. The coordinator rotates through registered current-season EventRuntime analytics state and pending TeamRuntime acknowledgements to recover stranded work, including completed events. Validate the new read-only and recovery paths locally, including restart and duplicate-dispatch cases.
- The web-side provider client files are not the provider packages: they add Redis caches, request locks, legacy conversion, and old acquisition behavior around the stateless `packages/providers/*` clients. Their deletion is desirable, but caller tracing is still incomplete; do not delete solely from their presence in the tree.
- The canonical web API routes inspected (event/team snapshots, webcasts, Statbotics match proxy) read canonical runtime state or Worker endpoints. They should remain thin adapters. The TBA webhook relay and `/api/ws` route are the remaining known compatibility bridges.

## First implementation sequence

1. **Freeze the target contract:** reconcile AGENTS.md and the migration plan with this approved strategy, keeping the one-Worker-per-environment decision and the 2026-11-24 ownership decision authoritative.
2. **Trace callers before deletion:** map imports and route callers for each legacy provider facade, Redis consumer, SharedWorker module, old scheduler/alarm, and compatibility endpoint.
3. **Retire duplicate provider acquisition:** remove the web-side provider clients/caches and obsolete routes once the caller scan proves they are unused or the remaining callers are intentionally being broken.
4. **Keep Worker deployment topology aligned:** retain the single `workers/fieldview` entrypoint and `wrangler.toml`. Production uses top-level settings and branch Previews use the same Worker's `previews` block. Do not reintroduce per-environment Worker names or Wrangler named environments. Preserve Durable Object class migration history.
5. **Replace mixed storage ownership:** implement separate Discovery and System Records repositories and classify all existing DiscoveryStore records before moving or dropping them.
6. **Coordinator/lifecycle implementation:** weekly event candidate projection, event-local eligibility, bounded direct dispatch, affected-team derivation, overlap protection, and aggregate workload budgets are implemented on the migration branch; remaining work is validation and aggregate provider-budget telemetry.
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
