# Production integration and cutover gate

**Target branch:** `fieldview-architecture-migration`  
**Purpose:** final integration validation before merge to `main` and production deployment  
**Resource baseline:** this branch has not been deployed; there is no branch-owned production data or legacy queue state to preserve.

## Objective

Validate the complete FieldView target architecture from a clean Cloudflare Preview baseline. The release is ready only when the application, runtime ownership boundaries, durable provider records, read projections, orchestration, and realtime data flow operate as one system.

This document is a release gate, not permission to deploy production. Merge and production deployment remain separate operator-approved actions.

## Governing contracts

1. EventRuntime and TeamRuntime are the canonical owners of provider endpoint records for their respective scopes.
2. A first-registration initialization Workflow may perform one bounded, idempotent acquisition of the initial provider endpoint resources to reliably hydrate a newly created runtime. It persists provider endpoint records only and is not a recurring provider path.
3. After initial bootstrap, ongoing provider acquisition is performed by the owning runtime in response to explicit refresh commands. The polling coordinator selects targets and dispatches; it does not fetch providers.
4. EventState and TeamState are ephemeral normalized read projections derived from stored provider endpoint records. They are not persisted canonical publications.
5. Snapshot reads are read-only: no provider calls, runtime registration, workflow dispatch, readiness mutation, or Durable Object storage writes.
6. Workflows own durable multi-step orchestration. The polling coordinator owns lifecycle cadence, prioritization, bounded concurrency, overlap prevention, and refresh dispatch.
7. Durable Object alarm polling, Cloudflare Queue refresh paths, Redis, R2, and browser IndexedDB normalized-state persistence are not part of the architecture.
8. Realtime is snapshot-first. The SharedWorker obtains the HTTP snapshot before subscribing to the single Multiplexer-owned `/stream`.
9. State notifications carry the actual changed EventState snapshot or team-event patch/data, together with identity and ordering/revision metadata. Analytics notifications carry the committed analytics publication. Revision-only invalidations are invalid.
10. Notifications, sequence gaps, disconnects, and reconnects never trigger hidden HTTP snapshot or analytics refetches. Reconnect restores subscriptions only.
11. TBA webhooks enter directly through the Worker. Remote display signaling is owned by RemoteSessionRuntime.
12. One environment-neutral Worker and one Wrangler configuration serve production and branch Previews. Preview bindings must not reach production data or Workflow instances.

## Gate 1 — Repository and contract validation

- Review the complete branch diff against `main`; verify that only intended product, runtime, configuration, test, and current documentation changes remain.
- Confirm there are no Redis/ioredis imports, Vercel WebSocket or webhook relays, browser provider clients, R2 bindings, Queue producers/consumers, or Durable Object alarm handlers/calls.
- Confirm provider acquisition is not duplicated after first-registration bootstrap.
- Confirm EventState/TeamState are derived from endpoint records at read time and no persisted normalized-state fallback exists.
- Confirm all state-change publications contain changed data, not revision-only invalidations.
- Confirm the SharedWorker does not issue HTTP reads in response to stream notifications, gaps, or reconnects.
- Confirm documentation and accepted ADRs describe ADR-0020 and the current single-Worker deployment topology.

## Gate 2 — Local validation

Run the repository's supported validation scripts:

```sh
npm ci
npm run typecheck
npm test
npm run lint
npm run build
npx wrangler deploy --dry-run --config workers/fieldview/wrangler.toml
```

Resolve failures before deployed Preview testing. Review warnings separately from gating failures.

## Gate 3 — Clean Preview integration

Use a clean, non-production Preview resource baseline. Preview D1 and KV must remain isolated from production. Do not bind Preview requests to production Workflows; use local execution or a separately provisioned non-production Workflow strategy where Preview Workflow bindings are unavailable.

Validate:

### Runtime creation and provider data
- Season discovery produces complete, validated event/team directories.
- First-registration workflows register the runtime and perform one bounded initial provider acquisition.
- Bootstrap is idempotent and persists endpoint payloads, validators, acquisition status, freshness, and revisions to the correct owning runtime.
- Bootstrap does not construct or persist EventState or TeamState.
- A retry cannot overwrite newer runtime data or regress revisions.
- Subsequent refreshes originate from EventRuntime/TeamRuntime, not from Workflow provider clients.

### Reads and storage
- Cold, warm, and post-eviction event/team snapshot reads derive equivalent normalized projections.
- Snapshot reads perform zero Durable Object storage writes and zero provider requests.
- Missing/unavailable/failed resources remain distinguishable from explicit null, zero, stale, and last-good data.
- Partial provider failures do not erase unrelated valid endpoint records.
- Analytics reads and discovery reads follow their own read-only contracts.

### Polling and analytics
- The polling coordinator applies lifecycle policy, provider request spacing, bounded concurrency, and overlap prevention.
- Refresh dispatch reaches only eligible EventRuntime/TeamRuntime identities.
- Analytics workflows consume versioned runtime inputs, publish only valid results, and preserve monotonic publication revisions.
- Team/event cross-runtime dependencies use explicit references and do not duplicate canonical aggregates.

### Realtime
- The browser obtains the HTTP snapshot before the single shared `/stream` connection.
- Event snapshot updates carry the changed EventState data.
- Team-event updates carry the changed patch/data and owning scope.
- Analytics notifications carry the committed analytics publication.
- The SharedWorker applies ordered messages and rejects duplicates/out-of-order revisions.
- No notification, acknowledgement, sequence gap, disconnect, or reconnect causes an HTTP snapshot or analytics refetch.
- Reconnect restores subscriptions only.

### Other runtime surfaces
- TBA webhook HMAC verification uses the raw request body and routes changes to the correct EventRuntime.
- RemoteSessionRuntime pairing, signaling, reconnect, and cleanup work.
- Admin authentication, operational controls, and Workflow status reflect the actual runtime lifecycle.
- D1, KV, and Durable Object usage remains within the approved operational budget.

Do not point public users or production TBA webhooks at Preview.

## Gate 4 — Production readiness review

- Review Preview evidence and the final Wrangler configuration.
- Confirm production D1/KV/DO/Workflow bindings and migration plan.
- Confirm secrets, Cloudflare Access policy, administrator authorization, and webhook destination.
- Confirm the Vercel frontend runtime URL and frontend environment configuration.
- Review provider rate budgets, Durable Object write behavior, Workflow concurrency, and operational monitoring.
- Confirm clean bootstrap and rollback/recovery procedures.
- Obtain explicit approval for merge and separately for production deployment.

## Gate 5 — Merge and cutover

After all gates pass:

1. Prepare and review the migration pull request and complete diff.
2. Merge to `main) only with explicit approval.
3. Provision/apply production D1 schema and required Cloudflare resources according to the reviewed cutover sequence.
4. Deploy the single `runtime` Worker using the top-level Wrangler configuration.
5. Configure direct TBA webhook delivery and production secrets/access.
6. Configure the Vercel frontend to use the production runtime URL.
7. Run production smoke checks for discovery, event/team snapshots, realtime updates, analytics, webhooks, and remote sessions.

Do not combine merge approval with deployment approval. Do not preserve retired infrastructure merely for compatibility.
