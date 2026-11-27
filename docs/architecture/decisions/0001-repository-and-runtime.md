# ADR 0001: Repository and runtime direction

- **Status:** Accepted, with migration strategy clarified
- **Date:** 2026-11-16
- **Decision owners:** FieldView project

## Context

FieldView is a FIRST Robotics Competition data application. Its repository separates the Next.js frontend, Cloudflare runtime, canonical FieldView domain, client contracts, provider adapters, and analytics so each can evolve without coupling the frontend to provider schemas or infrastructure details.

The migration branch is an owner-approved retire-first rebuild of the backend architecture. No resources from this branch have been deployed and there is no production data or legacy queue state to preserve. Compatibility layers for retired backend systems are not required.

## Decisions

1. Use **npm workspaces** for the monorepo.
2. **Retain Next.js** as the frontend framework.
3. Use a **Cloudflare Workers and Durable Objects backend** with one environment-neutral Worker named `runtime`.
4. Use Durable Objects for scope-owned canonical runtime state and coordination; use D1 for Discovery and System Records; use KV only for small non-authoritative projections and pointers.
5. Keep canonical domain models, client contracts, provider adapters, analytics, and runtime composition as separate dependency boundaries.
6. Keep reusable UI in the web application until a second real consumer justifies a shared UI package.
7. Use Cloudflare Workers Previews under the same Worker configuration for branch and pull-request integration testing; do not create Wrangler named environments or separate Worker identities.

## Consequences

- The repository contains `apps/web`, `apps/admin-cloudflare`, `workers/fieldview`, and focused packages under `packages/`.
- EventRuntime and TeamRuntime are separate scope-owned consistency and persistence boundaries.
- Vercel hosts the frontend only. Provider acquisition, backend persistence, Workflow orchestration, webhook ingress, and realtime delivery belong to Cloudflare.
- ADR-0020 defines provider endpoint storage, ephemeral EventState/TeamState projections, first-registration bootstrap, and snapshot-first/data-bearing realtime.
- Production deployment and merge are separate, explicit operator decisions. This ADR does not authorize either.

## Revisit criteria

Revisit a settled decision only when a concrete compatibility, operational, cost, or deployment constraint makes it materially impractical. Do not add compatibility infrastructure solely to preserve retired implementations.
