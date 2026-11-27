# Final Integration Plan

**Target branch:** `fieldview-architecture-migration`  
**Status:** Architecture implementation; final integration validation pending  
**Production state:** No resources from this branch have been deployed and there is no production data to preserve.

## Objective

Complete the intended final architecture on this branch, validate it end to end from a clean Cloudflare resource baseline, then merge to `main` for production deployment. Do not maintain adapters for the retired architecture. Do not preserve queue messages, Redis state, Vercel runtime endpoints, old browser acquisition, or legacy publication formats.

## Non-negotiable contracts

1. EventRuntime and TeamRuntime persist provider endpoint responses and acquisition metadata.
2. EventState and TeamState are normalized client projections created when a read is requested.
3. In-memory projections may accelerate repeated reads, but are disposable and must be regenerated after eviction.
4. No read path writes Durable Object storage or triggers provider acquisition.
5. Explicit bootstrap, refresh, webhook reconciliation, and Workflow operations own all provider writes.
6. Cloudflare Workflows and the Worker polling coordinator own scheduling. No queue-based readiness compatibility and no DO alarm polling.
7. The browser consumes only canonical Worker snapshots, analytics publications, and `/stream` notifications.
8. TBA webhooks target the Worker directly. Remote signaling is owned by RemoteSessionRuntime.
9. One environment-neutral Worker and one Wrangler configuration; Preview bindings are isolated from top-level bindings.
10. No R2 dependency.

## Final integration gates

### 1. Source and contract audit
- Confirm there are no Redis/ioredis clients, Vercel WebSocket routes, webhook relays, provider acquisition clients in the web app, legacy EventState polling, queue producers/consumers, or runtime alarm handlers.
- Confirm no compatibility fallback silently routes requests away from the Worker.
- Confirm no normalized EventState/TeamState is required during bootstrap.
- Confirm reads return projections from stored endpoint records and remain storage-write-free.
- Confirm all stale migration documentation and scripts describe this architecture.

### 2. Clean local validation
- `npm ci`
- `npm run typecheck`
- `npm test`
- `npm run lint`
- `npm run build`
- `npx wrangler deploy --dry-run --config workers/fieldview/wrangler.toml`

Resolve all failures before Preview testing.

### 3. Cloudflare Preview integration
Deploy only a branch Preview and apply its D1 migrations to the Preview database. Validate:
- Worker routes, authentication, assets, and bindings.
- Season discovery and event/team readiness.
- Initial provider bootstrap into EventRuntime and TeamRuntime.
- EventState and TeamState read-time projection, including cold reads after DO eviction.
- Zero Durable Object writes from snapshot, analytics-input, and discovery reads.
- Provider refresh intervals, bounded concurrency, retries, and last-good data behavior.
- Analytics Workflow publication and team acknowledgement.
- SharedWorker `/snapshot` + `/stream` flow, reconnect, and data-bearing updates.
- Direct TBA webhook HMAC verification and reconciliation.
- RemoteSessionRuntime pairing, reconnect, hibernation, and signaling.
- D1/KV/DO usage against free-tier and operational budgets.

Do not point TBA production webhooks or public users at Preview. Use controlled test credentials and payloads.

### 4. Production readiness
- Review Preview evidence and Cloudflare resource configuration.
- Confirm secrets, Access policy, TBA webhook destination, and Vercel frontend runtime URL.
- Confirm provider rate budgets and Durable Object write counts.
- Confirm rollback and clean bootstrap behavior.
- Obtain explicit approval before production deployment.

### 5. Merge and production deployment
Only after the Preview gates pass: prepare the migration PR, review the complete diff, merge to `main`, provision/apply the final Cloudflare resources, deploy the Runtime Worker, configure the direct TBA webhook destination, and connect the Vercel frontend. Merge and deployment are separate approval points.

## Explicitly retired

The target does not include Redis, ioredis, Vercel WebSocket delivery, a Vercel TBA webhook relay, web-side provider clients/caches, browser-owned EventState acquisition or polling, legacy queue consumers/producers, Durable Object alarm polling, R2, or persisted EventState/TeamState as a readiness prerequisite.
