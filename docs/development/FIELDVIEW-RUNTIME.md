# FieldView Runtime Development

The consolidated deployment entrypoint is `workers/fieldview/src/index.ts`, which composes the Runtime and Jobs modules into one Worker per environment. Runtime and Jobs are separated by concern under `workers/fieldview/src/runtime` and `workers/fieldview/src/jobs`; tests live under `workers/fieldview/test/runtime` and `workers/fieldview/test/jobs`. They are modules within one Worker project, not separate deployments. EventRuntime, TeamRuntime, Discovery, System Records, and Multiplexer responsibilities are defined by the accepted 2026-11-24 storage and polling decision. See [CLOUDFLARE-ENVIRONMENTS.md](./CLOUDFLARE-ENVIRONMENTS.md) for environment resources and deployment gates. Do not deploy or change remote settings as part of code migration without explicit authorization.

## Runtime secrets and configuration

Configure secrets as Cloudflare Worker secrets; never commit their values:

- `TBA_API_KEY` — TBA v3 read API key used by EventRuntime polling.
- `TBA_WEBHOOK_SECRET` — the secret configured for the TBA webhook; used to verify `X-TBA-HMAC`.
- `RUNTIME_ADMIN_TOKEN` — temporary prototype bearer authorization for administrative/internal routes and Worker-to-DO calls. It is not the production authorization design and must not be carried into production. Production deployment is blocked until proper system-administrator authorization replaces it.

Optional non-secret variables:

- `TBA_AUTHORITATIVE_REFETCH_DELAY_MS` — non-negative delay (default 65000 ms) for the one-shot authoritative TBA REST refetch after the immediate webhook-triggered refresh.
- `STATBOTICS_REFRESH_DELAY_MS` — non-negative delay (default 300000 ms) before the one-shot Statbotics enrichment request after a changed TBA REST representation.
- Legacy interval variables remain temporarily for compatibility with old lifecycle/alarm paths. They are not the target polling scheduler. The polling coordinator owns event eligibility, cadence, bounded dispatch, and aggregate budgets; remove these variables only after all old alarm callers are retired.

Statbotics currently requires no API credential.

For local development, use Wrangler's local secret workflow. For a future remote environment, set each secret explicitly for that environment before deploying. No secret values are stored in this repository.

## Worker routes

- `GET /health` — liveness response.
- `POST /webhooks/tba` — public TBA webhook ingress. Verifies HMAC-SHA256 over the exact raw request body before parsing JSON. Payloads are capped at 1 MB. TBA ping and verification notifications receive a 200 response; event notifications are routed to the EventRuntime named by the unchanged TBA event key.
- `POST /internal/polling/refresh` — authenticated coordinator command. It refreshes the specified EventRuntime first, then directly dispatches bounded refresh commands to up to 12 explicitly supplied affected TeamRuntime keys. Each TeamRuntime notification is scoped to the related event. The coordinator does not fetch provider data; each target runtime self-fetches and reconciles its own resources. This is direct bounded dispatch, not a Queue.
- `POST /internal/events/:eventKey/schedule` and `POST /internal/events/:eventKey/lifecycle` — legacy compatibility routes during migration. They still touch the former per-runtime alarm model and are not the target polling control surface. Do not build new polling features on them.
- The former global TaskScheduler routes are retired. Discovery refresh is a separate discovery operation; it does not schedule entity polling.
- `GET /internal/events/:eventKey/state` — authenticated inspection of current endpoint state.
- `GET /events/:eventKey/snapshot` — public, read-only canonical `FieldViewEventSnapshot`. No user login or browser-held service credential is required. The response exposes `X-FieldView-Snapshot-Version` and permits cross-origin browser reads; it is not cacheable at the Worker edge.
- `GET /teams/:teamKey/snapshot?year=YYYY` — public, read-only canonical `FieldViewTeamState` from an already registered TeamRuntime. Public reads never initialize the runtime or schedule provider work. An explicit refresh command makes the TeamRuntime fetch its own stale or requested resources and publish its canonical state.
- `GET /teams/:teamKey/season-analytics?year=YYYY` — public, read-only last-published team season analytics. It returns 204 when no aggregate exists; it never queues or calculates on GET.
- Admin operation `season-analytics-refresh` — explicit TeamRuntime calculation command. It calculates and persists the season aggregate from already-owned canonical inputs; it does not proxy provider acquisition.
- `GET /internal/teams/:teamKey/state` / `POST /internal/teams/:teamKey/refresh?year=YYYY` — authenticated TeamRuntime inspection and one-shot refresh controls.
- `GET /events/discovery?year=YYYY` — public, read-only event discovery projection. Discovery is owned by the Discovery repository, not by a runtime or operational-record store. It does not trigger an upstream request.
- District aggregate acquisition and TaskScheduler-owned district routes are retired; district membership remains part of the owning team/event provider data.
- `GET /stream` — public, read-only WebSocket to the single shared Multiplexer Durable Object. Browser clients send validated `subscribe` / `unsubscribe` messages for `event-state` or `analytics` topics and `ping` for keepalive. The multiplexer serves multiple clients, deduplicates event-state registration with EventRuntime, and forwards revision-only notifications only to subscribed clients. EventRuntime publishes analytics revisions independently from event-state revisions, and the Multiplexer forwards analytics revision notifications to subscribed clients.
- `GET /events/:eventKey/stream?since=:version` — temporary public, read-only event-scoped compatibility stream. The shared `/stream` route is the intended browser integration path; clients fetch the canonical snapshot after a gap or newer revision.
- `OPTIONS /events/:eventKey/snapshot` — CORS preflight for public snapshot reads.
- `GET /internal/events/:eventKey/snapshot` — authenticated administrative/internal canonical snapshot route (retained for service-side inspection).

The multiplexer calls EventRuntime's internal `POST /subscriptions` operation to register or unregister its shared subscriber identity. Each request carries a monotonically increasing generation for that event; EventRuntime persists the newest generation and ignores stale out-of-order requests. The multiplexer reconciles desired upstream state after each client subscription-set change. EventRuntime sends `snapshot.changed` revision metadata to the multiplexer only while that registration is active. The multiplexer accepts internal `POST /internal/notify` deliveries only with the service bearer token; these internal DO-to-DO paths are not exposed as public Worker routes.

## Frontend integration

Server-rendered event pages and the events browser use `NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL` as the canonical Worker origin in the migration preview. Event, team, and district pages consume FieldView snapshots and discovery records; they do not fall back to direct TBA acquisition when canonical resources are missing. Missing resources remain unavailable until the corresponding runtime has acquired them, and explicit `null` values remain unavailable rather than being silently replaced. The team page composes TeamRuntime-owned team/season data with EventRuntime-owned event data. District pages consume TaskScheduler-owned district directory and snapshot routes. No production runtime URL is configured.

### SharedWorker integration

The existing SharedWorker has an opt-in canonical runtime transport. Set the web application's build-time `NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL` to the Cloudflare Worker base origin to enable it. The SharedWorker then uses its single browser WebSocket connection for the public `/stream` multiplexer, replays event-state subscriptions after reconnect, and fetches versioned canonical snapshots from `/events/:eventKey/snapshot` after subscription acknowledgement, reconnect, or a newer revision notification.

New consumers can use `getCanonicalEventSnapshot` and `subscribeCanonicalEventSnapshot` from `apps/web/src/lib/events/sharedWorkerClient.ts`. The canonical snapshot is the `@fieldview/domain` `FieldViewEventSnapshot`, not a second client DTO. Snapshot versions are compared before replacing cached state so an older in-flight response cannot overwrite a newer snapshot.

When `NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL` is unset, the SharedWorker retains its existing Vercel WebSocket behavior. When enabled, existing `EventState` consumers still use their legacy REST read path as a temporary compatibility layer and respond to runtime revision notifications by refreshing that path; the new canonical snapshot API is available for incremental UI migration. No production URL is configured and no production UI cutover has occurred. The event detail page and events browser now have opt-in canonical read paths; this setting must not be enabled in production before deployment and explicit cutover approval. Analytics subscription and recovery are connected: the SharedWorker subscribes to the independent analytics revision topic and fetches the canonical publication after notifications or reconnect.

## Ownership and data handling

Each event maps to one EventRuntime Durable Object and each TBA team key maps to one TeamRuntime Durable Object. These are the same runtime abstraction at different scopes. Both expose the same explicit refresh-command contract and own their scope-specific endpoint validators, provider representations, reconciliation, canonical state, retries, and publication. EventRuntime owns event-scoped resources and EventState; TeamRuntime owns team/season/team-event resources and TeamState. Neither runtime owns or persists the other's provider resources or canonical records.

The polling coordinator is the sole owner of recurring lifecycle scheduling, target selection, bounded concurrency, overlap prevention, and aggregate budgets. It sends one refresh command to each eligible EventRuntime and commands to only those TeamRuntimes whose owned data/projections are affected. Each runtime fetches its own provider resources; the coordinator never acts as a provider proxy or constructs canonical deltas. Direct dispatch is the default; do not introduce a Queue merely to batch calls. Existing runtime-local queues and alarms are transitional and must be removed only after every recurring poll, webhook follow-up, retry, analytics dependency, and recovery path has a coordinator-owned replacement.

Discovery owns event/team directories and current-season metadata. System Records owns Workflow execution, runtime registration, admin actions, and operational history. Durable Objects own canonical EventState/TeamState and endpoint state. High-volume diagnostic logs belong in platform observability rather than Discovery or canonical runtime storage.

A webhook never changes an HTTP ETag or its corresponding `providerData`. Authenticated Worker ingress routes the original payload to the runtime scopes whose owned projections are affected. EventRuntime applies event-owned match/webcast/awards updates; TeamRuntime updates only team-owned projections and never copies EventRuntime match records. The polling coordinator owns any follow-up refresh fan-out and issues direct commands to the affected runtimes. A runtime does not dispatch to the other runtime.

Duplicate identical payloads are idempotently ignored using a SHA-256 digest of the raw body. Failed polling preserves the last good endpoint representation and validator. HTTP 304 is a strict no-op: no endpoint metadata, timestamps, diagnostics, revisions, snapshots, or durable writes change. A 200 without an ETag explicitly clears the previous validator. Any delayed webhook follow-up or provider retry must be represented as an explicit coordinator-owned operation with a bounded deadline and budget; do not create recurring per-runtime alarm polling as a substitute.

## Local validation

From the repository root:

- `npm test` runs domain, TBA provider, endpoint-state, reconciliation, source-version, webhook-signature, TeamRuntime lifecycle/route, and frontend snapshot tests.
- `npm run typecheck` also typechecks the Worker entrypoint and EventRuntime adapter.

The canonical event snapshot includes TBA matches and playoff alliance associations, plus the unchanged Statbotics event-match collection associated by exact match key. EventRuntime Statbotics match data is refreshed only after a changed TBA event/team/status/match REST representation, with a five-minute default debounce and bounded retries. TeamRuntime Statbotics team-year/team-event data is refreshed after changed TBA team or season-event-list representations and is not a recurring poll. Analytics recalculation remains a separate persisted, coalesced downstream job. The Runtime Worker configurations declare SQLite-backed EventRuntime, TeamRuntime, and Multiplexer Durable Objects. Readiness Workflows inspect durable publication/source coverage; live polling is a separate coordinator responsibility. The consolidated Worker deployment remains the target for both environments. See [CLOUDFLARE-ENVIRONMENTS.md](./CLOUDFLARE-ENVIRONMENTS.md) for the branch-to-configuration mapping.

## Analytics execution and invalidation

- EventRuntime and TeamRuntime execute canonical analytics through the versioned `packages/analytics` definition catalog and its explicit `AnalyticsOperationRegistry`. Definition source paths are descriptive metadata; they are never evaluated as executable expressions. Calculation implementations remain pure operation handlers.
- EventRuntime owns event-wide alliance, qualification, playoff, match-flag, and collection analytics. TeamRuntime owns per-team/per-event investigation and season-comparison analytics. Cross-runtime analytics inputs are selected and dispatched by the coordinator or a dedicated Workflow; EventRuntime and TeamRuntime must not invoke each other directly.
- The invalidation planner maps provider/source changes to match-analysis, event-aggregate, team-aggregate, playoff-aggregate, and season-comparison scopes. Match keys are retained and coalesced as hints. Execution currently retains the full-event fallback for every source because residual distributions and peer/team baselines share event-wide dependencies; no source is allowed to bypass those dependencies through a partial calculation.
- The analytics workspace tests include full CTHAR (89 matches) and MAWNE (91 matches) match collections from the 2026 cohort archive, with Team 3461's 15 and 14 appearances respectively. They compare engine-backed event outputs and TeamRuntime investigation/season-comparison outputs against the direct calculation implementations. The fixture is targeted at Team 3461 and is not an all-team OPR/percentile parity fixture.
- The former Next.js progressive event analytics orchestration and unused web calculation facade have been retired. Legacy insights API paths remain compatibility redirects to canonical runtime endpoints.
