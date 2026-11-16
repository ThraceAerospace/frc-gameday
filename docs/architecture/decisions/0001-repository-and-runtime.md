# ADR 0001: Repository and runtime direction

- **Status:** Accepted
- **Date:** 2026-11-16
- **Decision owners:** FieldView project

## Context

FieldView currently runs as a single Next.js application with Vercel-hosted route handlers, Redis-backed provider caches/jobs, and browser-owned SharedWorker/EventState acquisition. The target needs a reusable backend data layer, normalized domain contracts, durable event coordination, and a frontend that is not coupled to provider schemas or runtime implementation details.

The migration must preserve the existing application while responsibilities move in controlled slices. A clean rebuild would create unnecessary behavioral and data-parity risk.

## Decisions

1. Use **npm workspaces** for the monorepo.
2. **Retain Next.js** as the frontend framework.
3. Use an **incremental migration**. Keep the existing application operational until each replacement slice is validated and its consumers are migrated.
4. Use a **hybrid Cloudflare Workers + Durable Objects backend**:
   - Workers are the default stateless request/trigger execution environment.
   - Durable Objects are introduced for stateful coordination, persistence, ordering, or realtime ownership where justified.
5. Keep canonical domain models, client contracts, provider adapters, analytics, and application/runtime composition as separate dependency boundaries.
6. Keep reusable UI in the web application until a second real consumer justifies a shared UI package.

## Consequences

- The repository will gain `apps/web`, `workers/backend`, and focused packages under `packages/`.
- The existing Next.js application has been relocated to `apps/web` and registered as the `@fieldview/web` npm workspace. Local clean-install and production-build validation passed.
- The first runtime candidate is one EventRuntime per event, but exact state ownership remains subject to a separate decision.
- No Cloudflare resource or production cutover is implied by this ADR.
- The Vercel migration-branch Ignored Build Step remains a project-level deployment safeguard and is not changed by repository commits.

## Revisit criteria

Revisit only if a concrete compatibility, operational, cost, or deployment constraint makes one of these decisions materially impractical. Do not reopen settled preferences without evidence.
