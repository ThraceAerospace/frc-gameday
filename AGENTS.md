# FieldView Agent Instructions

These instructions describe the intended production architecture. When older documentation or code comments conflict with these rules, follow the accepted architecture decisions, especially ADR-0020, and update the stale material rather than adding compatibility behavior.

## Product and repository

FieldView is a FIRST Robotics Competition data application. The repository is an npm-workspace monorepo:

- `apps/web`: Next.js frontend.
- `apps/admin-cloudflare`: Cloudflare-hosted admin assets.
- `workers/fieldview`: the single Cloudflare Worker project.
- `packages/domain`: canonical FieldView domain model and normalization.
- `packages/contracts`: serializable client-facing contracts.
- `packages/providers/*`: isolated upstream provider clients and generated schemas.
- `packages/analytics`: reusable analytics calculations.

## Deployment architecture

- Deploy one environment-neutral Cloudflare Worker named `runtime`.
- Use only `workers/fieldview/wrangler.toml`; do not introduce Wrangler named environments or separate preview/staging/production Worker identities.
- Production configuration is top-level. Branch and pull-request validation uses Cloudflare Workers Preview URLs and explicit Preview bindings in the same configuration.
- The frontend is hosted on Vercel. Vercel does not own provider acquisition, canonical backend persistence, workflow orchestration, webhook processing, or realtime delivery.
- Keep Worker local variables in `workers/fieldview/.dev.vars`; keep frontend environment variables in the Vercel project. Never expose Worker credentials to the browser.
- Cloudflare resources are provisioned and deployed only through explicitly approved operator actions. Do not deploy, mutate, or delete remote resources as an incidental development step.

## Runtime ownership and provider acquisition

- EventRuntime is the sole owner of event-scoped provider endpoint records and event-scoped canonical state.
- TeamRuntime is the sole owner of team/year-scoped provider endpoint records and team-scoped canonical state.
- Each runtime owns ongoing provider requests, validators/ETags, freshness, reconciliation, persistence, retry behavior, and publications for its scope.
- The polling coordinator selects eligible runtime identities, enforces concurrency/budget/overlap rules, and dispatches explicit bounded refresh commands. It must not proxy provider requests or build provider payloads.
- Workflows own durable multi-step orchestration: discovery, season ingestion, runtime registration/initialization, analytics jobs, and administrative workflows.
- **One-time initialization exception:** when a runtime is first registered/created, its initialization Workflow may explicitly acquire the initial provider endpoint resources and pass them to that runtime so its durable store is reliably hydrated. This is a bounded bootstrap operation, not an alternate ongoing provider path. It must not create or persist EventState/TeamState projections. Once initialization completes, all subsequent provider acquisition is performed by the owning runtime.
- A Workflow must not repeatedly reacquire provider resources as a substitute for runtime refresh. Initialization must be idempotent and tied to the first-registration lifecycle.
- Public reads never acquire provider data, schedule work, create runtime registrations, or mutate storage.

## Storage and state contracts

- Durable Object SQLite is the canonical store for runtime-owned provider endpoint records and runtime-scoped state.
- D1 owns discovery records and operational/system records, through typed repository methods.
- KV is limited to small, disposable, non-authoritative projections and canonical pointers.
- Do not introduce R2, Redis/ioredis, Cloudflare Queue producer/consumer paths, generic object-storage HTTP APIs, or browser IndexedDB persistence for normalized state.
- Durable Object alarm polling is not used. Do not add `alarm()` handlers or call `setAlarm()` / `deleteAlarm()`. The polling coordinator and explicitly started Workflows own scheduling.
- EventState and TeamState are normalized client-facing projections. Build them at read time from the owning runtime's durable provider endpoint records. They may be retained in disposable memory as a hot cache, but must not be persisted as canonical state.
- A snapshot read must not write Durable Object storage. Cache eviction must only cause the projection to be recomputed.
- Analytics publications and TeamEventState records are separate purpose-specific persisted outputs. They are not EventState/TeamState persistence and do not gate ordinary snapshot projection.

## Realtime contract (ADR-0020)

- The browser obtains its canonical HTTP snapshot before opening the shared `/stream` WebSocket.
- Multiplexer owns the single public stream and subscription coordination.
- Event and team runtime changes are delivered as data-bearing notifications: include the actual changed snapshot/patch data, its scope/identity, and the ordering/revision metadata needed by clients to apply it safely.
- Analytics notifications carry the committed analytics publication.
- A revision-only invalidation is not a valid state-change notification.
- The SharedWorker applies valid, ordered updates to its in-memory cache. It does not persist normalized snapshots in IndexedDB.
- Notifications, acknowledgements, gaps, disconnects, and reconnects do not trigger HTTP snapshot or analytics refetches. Reconnect restores subscriptions only. A new page/client read or explicit user refresh may perform an HTTP read.
- Do not add a parallel per-event WebSocket endpoint or a second browser-side polling/cache implementation.

## Domain and provider boundaries

1. FieldView owns its canonical domain model. Provider APIs are inputs, not client contracts.
2. Provider packages own generated schemas, transport, credentials, provider-specific validation, retry/rate-limit behavior, and unchanged provider payload acquisition.
3. Domain normalization owns cross-provider correlation, canonical FieldView model construction, explicit transformations, and field-level source precedence.
4. Analytics calculations belong in `packages/analytics` or the approved backend orchestration around it, not in presentation components.
5. Client contracts must not expose provider response envelopes or provider-specific types.
6. Preserve source provenance and freshness. Distinguish missing/unavailable data, explicit null/clear, zero, stale values, and failed acquisition.
7. Partial provider failures must not erase unrelated valid data. Apply explicit source precedence; do not let request completion order determine ownership.
8. Canonical entities have one owning runtime. Cross-runtime relationships use stable references and revisions, not duplicated nested canonical objects.
9. Keep domain and analytics packages independent of Next.js, Cloudflare APIs, and provider transport at runtime.

## Implementation rules

- Inspect the existing implementation and tests before changing an interface or lifecycle.
- Keep runtime and jobs responsibilities explicit. Do not create alternate paths for the same provider acquisition, persistence, or publication responsibility.
- Keep reads side-effect-free. A public read must not initialize, refresh, schedule, or write.
- Preserve idempotency and concurrency boundaries for Workflows and refresh dispatch.
- Prefer small, prop-driven reusable UI components. Do not add page-load-blocking provider calls or implicit data fetches in shared shells.
- Do not add a new page data fetch without approval. In particular, do not reintroduce hidden season/event fetches in shared layout components.
- Keep tests aligned with production contracts. Test notes and historical audit documents are not architectural authority.
- Do not claim a capability, deployment, data migration, or production cutover is complete without evidence.

## Validation and cutover

Before merge/production cutover, validate:
- workspace typecheck, tests, lint, and production builds;
- D1 schema/migration correctness and Wrangler dry-run;
- clean Preview resource creation and binding isolation;
- one-time event/team runtime registration and provider bootstrap;
- cold/warm/evicted EventState and TeamState reads with zero DO writes;
- runtime-owned ongoing refresh, validators, partial failure, and concurrency behavior;
- analytics orchestration and revision monotonicity;
- snapshot-first realtime with data-bearing notifications and no WSS-triggered HTTP reads;
- TBA raw-body webhook authentication and correct event routing;
- remote-session signaling and cleanup;
- admin access and production authorization.

Do not merge to `main`, deploy production, or alter production resources unless explicitly authorized.
