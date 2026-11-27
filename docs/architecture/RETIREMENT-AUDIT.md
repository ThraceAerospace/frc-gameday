# Compatibility Retirement Audit

**Branch:** `fieldview-architecture-migration`  
**Status:** On-demand state-generation realignment is implemented; core CI integration validation passes. Final repository-wide source scan remains.

## Owner direction

This branch is a clean-slate replacement. None of its Cloudflare resources have been deployed, and there is no production data or queue state to preserve. Do not keep code solely to read old queue messages, bridge old Vercel endpoints, hydrate legacy browser state, or support old storage layouts.

## Retirements applied

- Removed the legacy `fieldview-season-refresh` Queue consumer and its consumer handler.
- Removed queue-shaped readiness result fields and queue-specific observability tests.
- Removed Vercel `/api/ws`, Redis Pub/Sub event delivery, and the web-side realtime bridge.
- Removed the Vercel TBA webhook relay; TBA ingress is the Worker `/webhooks/tba` route directly.
- Removed the browser-owned `EventState` implementation and its REST polling fallback.
- Reduced SharedWorker responsibilities to canonical EventRuntime snapshot and analytics subscriptions.
- Removed the deleted `CanonicalEventSnapshotsProvider` and its remote-display relay mode; remote displays consume their own canonical SharedWorker stream.
- Replaced obsolete frontend snapshot type imports with the canonical `FieldViewEventState`, `FieldViewTeamState`, provider media, and `FieldViewTeamEventAnalytics` contracts.
- Removed web-side TBA, Statbotics, and FRC Colors provider clients/caches; provider adapters live in shared provider packages and Worker acquisition.
- Removed direct Redis, ioredis, `ws`, and Vercel Functions dependencies from the web workspace.
- Removed the R2-shaped DiscoveryService object wrapper and generic `/get`, `/put`, `/list` HTTP record API; internal callers now use typed D1 JSON-record methods.
- Removed browser IndexedDB persistence for normalized snapshots; the SharedWorker cache is memory-only.
- Provider refresh and webhook paths now persist endpoint records and publish revision-only invalidations; canonical `EventState` and `TeamState` are assembled on explicit snapshot/analytics reads, not as refresh side effects.
- Removed the per-event EventRuntime WebSocket route; the public `/stream` endpoint is Multiplexer-only.
- Consolidated the undeployed Durable Object class migration into one initial migration.
- Removed the root `.env.example` and changed local Worker development to use `workers/fieldview/.dev.vars`.

## Final source-scan requirements

Before merge, verify that no references remain to:
- `REDIS_URL`, `ioredis`, Redis Pub/Sub, or Redis request locks.
- `NEXT_PUBLIC_REMOTE_WEBSOCKET_URL`, `/api/ws`, or `@vercel/functions`.
- `/api/tba/webhook` or `broadcastTBAEvent`.
- `EventState` browser acquisition, polling, or legacy snapshot providers (distinguish the canonical domain contract `FieldViewEventState`).
- `fieldview-season-refresh`, queue producers/consumers, or queue-shaped readiness payloads.
- Runtime Durable Object alarm handlers or alarm scheduling.
- Web-side provider clients that call TBA, Statbotics, or FRC Colors directly.
- Persisted EventState/TeamState as a readiness requirement.

## Retained target components

Keep the canonical domain/provider/analytics packages, EventRuntime, TeamRuntime, Multiplexer, RemoteSessionRuntime, Workflows, Worker polling coordinator, D1 repositories, KV projections, direct Worker webhook ingress, SharedWorker canonical transport, and the Vercel-hosted Next.js presentation layer.

## Validation

The latest code commit `901312f3a7ee4e23005b5b8d070133e721a83bf6` passed D1 schema validation, Next.js type generation, administrator asset build, Wrangler dry run, workspace typecheck, all workspace tests, and lint in GitHub Actions run [#46078612151](https://github.com/ThraceAerospace/frc-gameday/actions/runs/46078612151).

## Deployment boundary

This audit authorizes source retirement on the migration branch only. It does not itself deploy, merge, or modify Cloudflare/Vercel account settings. Preview deployment and production deployment remain separate integration/approval steps.
