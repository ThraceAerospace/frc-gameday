# FieldView Runtime Development

The Cloudflare runtime source is under `workers/fieldview-runtime`. FieldView has two persistent Worker targets: `runtime` for `main` and `testing` for every non-main branch. Their Wrangler configurations are selected explicitly by branch; see [CLOUDFLARE-ENVIRONMENTS.md](./CLOUDFLARE-ENVIRONMENTS.md) for resource separation, operator commands, and deployment gates. The fixed runtime URLs are `https://runtime.frc-fieldview.workers.dev` and `https://testing.frc-fieldview.workers.dev`. No remote deployment, Vercel setting change, or production cutover is performed by this repository configuration.

## Runtime secrets and configuration

Configure secrets as Cloudflare Worker secrets; never commit their values:

- `TBA_API_KEY` — TBA v3 read API key used by EventRuntime polling.
- `TBA_WEBHOOK_SECRET` — the secret configured for the TBA webhook; used to verify `X-TBA-HMAC`.
- `RUNTIME_ADMIN_TOKEN` — current temporary bearer authorization for administrative scheduling/state routes and Worker-to-DO calls. Configure only in the isolated testing environment. It is not approved for production; production deployment is blocked until the system-administrator authorization design replaces this mechanism.

Optional non-secret variables:

- `TBA_AUTHORITATIVE_REFETCH_DELAY_MS` — non-negative delay (default 65000 ms) for the one-shot authoritative TBA REST refetch after the immediate webhook-triggered refresh.
- `STATBOTICS_REFRESH_DELAY_MS` — non-negative delay (default 300000 ms) before the one-shot Statbotics enrichment request after a changed TBA REST representation.
- `EVENT_DISCOVERY_INTERVAL_MS` — global TBA event discovery cadence (default 3600000 ms / 1 hour).
- `EVENT_UPCOMING_INTERVAL_MS` — polling cadence for upcoming-event resources (default 1800000 ms / 30 minutes).
- `EVENT_ACTIVE_INTERVAL_MS` — polling cadence for live match/status/alliance/OPR/prediction resources during active events (default 300000 ms / 5 minutes).
- `EVENT_COMPLETED_RETENTION_MS` — how long completed events remain scheduled (default 86400000 ms / 24 hours).
- `TEAM_REFRESH_INTERVAL_MS` — refresh cadence for team-scoped TBA resources (default 86400000 ms / 24 hours; minimum 60000 ms).

Statbotics currently requires no API credential.

For local development, use Wrangler's local secret workflow. For a future remote environment, set each secret explicitly for that environment before deploying. No secret values are stored in this repository.

## Worker routes

- `GET /health` — liveness response.
- `POST /webhooks/tba` — public TBA webhook ingress. Verifies HMAC-SHA256 over the exact raw request body before parsing JSON. Payloads are capped at 1 MB. TBA ping and verification notifications receive a 200 response; event notifications are routed to the EventRuntime named by the unchanged TBA event key.
- `POST /internal/events/:eventKey/schedule` — authenticated administrative scheduling. Body: `{ "endpoints": ["/event/..."], "intervalMs": 60000 }`. Endpoints must be in the EventRuntime's event-scoped TBA endpoint allowlist; Statbotics cannot be scheduled administratively.
- `POST /internal/events/:eventKey/lifecycle` — authenticated lifecycle administration/diagnostics. Accepts `upcoming`, `active`, `completed`, or `expired`; the completed transition stores an absolute `completedUntil` deadline. The EventRuntime alarm is armed for the earlier of the next polling task or the completed-retention deadline, so expiration is not delayed by a longer polling interval.
- `POST /internal/scheduler/start` / `stop`, `GET /internal/scheduler/state` — authenticated controls for the global durable event-discovery scheduler. Start performs discovery immediately, then repeats at the configured cadence. The scheduler is intentionally not auto-started by a Cron Trigger.
- `GET /internal/events/:eventKey/state` — authenticated inspection of current endpoint state.
- `GET /events/:eventKey/snapshot` — public, read-only canonical `FieldViewEventSnapshot`. No user login or browser-held service credential is required. The response exposes `X-FieldView-Snapshot-Version` and permits cross-origin browser reads; it is not cacheable at the Worker edge.
- `GET /teams/:teamKey/snapshot?year=YYYY` — public, read-only canonical `FieldViewTeamState` from the lazily created TeamRuntime named by the unchanged TBA team key. It includes team identity, district memberships, season events, media, and Statbotics team-year/team-event resources. Initial TBA/FRC Colors acquisition is scheduled through a Durable Object alarm. Statbotics team-year/team-event acquisition is one-shot and triggered by changed TBA team or season event-list representations; it is not periodically polled. Explicit seed/refresh operations may still request one-shot Statbotics acquisition.
- `GET /internal/teams/:teamKey/state` / `POST /internal/teams/:teamKey/refresh?year=YYYY` — authenticated TeamRuntime inspection and one-shot refresh controls.
- `GET /events/discovery?year=YYYY` — public, read-only array of normalized `FieldViewEvent` objects from TaskScheduler's durable TBA discovery cache. It does not trigger an upstream request; it returns 503 until that year's cache has been populated. Payload provenance is `available` after recent successful validation and `stale` after two missed discovery intervals.
- `GET /districts/discovery?year=YYYY` — public, read-only canonical `FieldViewDistrictDirectory` from TaskScheduler-owned district directory cache.
- `GET /districts/:districtKey/snapshot?year=YYYY` — public, read-only canonical `FieldViewDistrictSnapshot` composed from independently cached district metadata, teams, events, rankings, and advancement resources. Neither route triggers provider acquisition.
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

Each event maps to one EventRuntime Durable Object. It owns endpoint validators, exact latest HTTP representations, locally reconciled endpoint values, immutable accepted-200 source versions, raw webhook deliveries, and event-scoped poll tasks. Each TBA team key maps lazily to one TeamRuntime Durable Object, which owns team identity, districts, season event lists, media, team-scoped Statbotics records, per-resource validators/provenance, and refresh tasks. TeamRuntime never duplicates event-scoped resources. TBA/FRC Colors profile resources are periodically refreshed; Statbotics team-year/team-event resources are refreshed only after changed TBA team or season event-list representations (or explicit seed/refresh actions), not by recurring polling. Legacy recurring Statbotics tasks are removed on next TeamRuntime access. One global TaskScheduler Durable Object discovers the current calendar year hourly using ETags, owns district acquisition/cache, and assigns lifecycle-aware schedules.

A webhook never changes an HTTP ETag or its corresponding `providerData`. Full match-score/video notifications update the local match list using the unchanged TBA match record; schedule/upcoming-match notifications trigger an immediate matches refresh; alliance-selection and awards notifications trigger their corresponding refreshes. Other notification payloads are retained without inventing an update. For webhook types that trigger REST refreshes, the runtime performs the immediate refresh and retains a one-shot authoritative refetch 65 seconds later by default (`TBA_AUTHORITATIVE_REFETCH_DELAY_MS`); this gives TBA's REST API time to catch up without introducing a recurring 65-second poll. The delayed follow-up remains separate from the downstream Statbotics settling delay.

Duplicate identical payloads are idempotently ignored using a SHA-256 digest of the raw body. Failed polling preserves the last good endpoint representation and validator. A single Durable Object alarm services event-scoped tasks. TBA polling intervals are explicitly supplied by the scheduler; webhook-triggered TBA one-off polls retry until successful. Statbotics is never independently polled: an accepted change to the TBA event, team, team-status, or match REST representation schedules a debounced Statbotics match refresh. The default debounce is five minutes and is configurable with `STATBOTICS_REFRESH_DELAY_MS`. Each TBA-triggered refresh allows at most four attempts (one initial request plus three bounded retries on provider failure or HTTP 304); retry exhaustion ends that trigger, and a later changed TBA representation may trigger another refresh. Failed attempts preserve the last good representation.

## Local validation

From the repository root:

- `npm test` runs domain, TBA provider, endpoint-state, reconciliation, source-version, webhook-signature, TeamRuntime lifecycle/route, and frontend snapshot tests.
- `npm run typecheck` also typechecks the Worker entrypoint and EventRuntime adapter.

The canonical event snapshot includes TBA matches and playoff alliance associations, plus the unchanged Statbotics event-match collection associated by exact match key. EventRuntime Statbotics match data is refreshed only after a changed TBA event/team/status/match REST representation, with a five-minute default debounce and bounded retries. TeamRuntime Statbotics team-year/team-event data is refreshed after changed TBA team or season-event-list representations and is not a recurring poll. Analytics recalculation remains a separate persisted, coalesced downstream job. The Runtime Worker configurations declare SQLite-backed EventRuntime, TeamRuntime, and Multiplexer Durable Objects. The production Jobs Worker owns the daily event-readiness Workflow schedule; the shared testing Jobs Worker intentionally has no recurring schedule. See [CLOUDFLARE-ENVIRONMENTS.md](./CLOUDFLARE-ENVIRONMENTS.md) for the branch-to-configuration mapping.

## Analytics execution and invalidation

- EventRuntime and TeamRuntime execute canonical analytics through the versioned `packages/analytics` definition catalog and its explicit `AnalyticsOperationRegistry`. Definition source paths are descriptive metadata; they are never evaluated as executable expressions. Calculation implementations remain pure operation handlers.
- EventRuntime owns event-wide alliance, qualification, playoff, match-flag, and collection analytics. TeamRuntime owns per-team/per-event investigation and season-comparison analytics. EventRuntime composes the independently persisted TeamRuntime outputs.
- The invalidation planner maps provider/source changes to match-analysis, event-aggregate, team-aggregate, playoff-aggregate, and season-comparison scopes. Match keys are retained and coalesced as hints. Execution currently retains the full-event fallback for every source because residual distributions and peer/team baselines share event-wide dependencies; no source is allowed to bypass those dependencies through a partial calculation.
- The analytics workspace tests include full CTHAR (89 matches) and MAWNE (91 matches) match collections from the 2026 cohort archive, with Team 3461's 15 and 14 appearances respectively. They compare engine-backed event outputs and TeamRuntime investigation/season-comparison outputs against the direct calculation implementations. The fixture is targeted at Team 3461 and is not an all-team OPR/percentile parity fixture.
- The former Next.js progressive event analytics orchestration and unused web calculation facade have been retired. Legacy insights API paths remain compatibility redirects to canonical runtime endpoints.
