# ADR: Retire web-side provider acquisition

- **Date:** 2026-11-24
- **Status:** Accepted
- **Branch:** `fieldview-architecture-migration`

## Decision

Provider acquisition belongs to the FieldView backend runtime and the stateless packages under `packages/providers/*`. The web application must not maintain a second provider-acquisition/cache layer in Redis.

Retire the legacy web-side TBA, Statbotics, and FRC Colors acquisition facades and their Redis-backed caches/locks. Move remaining web consumers to canonical FieldView runtime/API contracts as those contracts are made available. Do not replace the Redis caches with another browser/Vercel provider cache or a new duplicate acquisition path.

**Remote-control Redis is explicitly retained for now.** The Redis connection/package remains while remote-session presence, controller ownership, and WebRTC signaling use it. Event realtime's Redis bridge is a separate migration and is not part of this provider-acquisition decision.

## Existing source findings

The migration branch currently has three web-side acquisition implementations:

- `apps/web/src/lib/tba/client.ts`: Redis response cache, ETag/Cache-Control handling, tag invalidation, webhook cache mutation, and match-result reconciliation. `apps/web/src/lib/tba/service.ts` exposes a broad facade used by many pages, components, and API routes.
- `apps/web/src/lib/statbotics/client.ts`: Redis response cache, request locks, cooldowns, stale fallback, and paginated acquisition. Its service is consumed by insights and match UI. The API route `/api/statbotics/match/[match]` already proxies the FieldView Worker and is not a legacy provider-acquisition route.
- `apps/web/src/lib/frc-colors/client.ts`: Redis cache and request lock around the stateless provider package; the progressive insights service consumes the legacy facade.

The stateless provider packages under `packages/providers/{tba,statbotics,frc-colors}` are retained. They are transport/schema building blocks for backend acquisition, not the obsolete web-side cache layer.

## Migration sequence

1. Trace every import and runtime caller of the three web-side facades, including page loaders, API routes, components, insights, webhook handlers, and tests.
2. Map each consumer to an existing canonical EventRuntime/TeamRuntime/API contract. Where a required contract does not yet exist, add it to the backend migration plan rather than falling back to direct provider acquisition.
3. Migrate consumers in coherent groups, preserving domain-level semantics and useful presentation behavior.
4. Remove the web-side provider clients, cache helpers, Redis tag/lock logic, and obsolete provider-shaped routes once no live consumer depends on them.
5. Keep `apps/web/src/lib/cache/redis.ts` and the Redis dependency while remote-control signaling still needs them. Do not delete Redis wholesale.
6. Verify with repository-wide import scans, typecheck, tests, and a build. Temporary UI/API breakage is acceptable on this migration branch, but report the exact remaining breakage rather than claiming the migration is complete.

## Guardrails

- Do not change remote-control storage in this work.
- Do not remove the canonical provider packages or generated provider schemas.
- Do not add provider HTTP requests to browser components or new Vercel routes.
- Do not change production resources, deploy, or merge to `main`.
