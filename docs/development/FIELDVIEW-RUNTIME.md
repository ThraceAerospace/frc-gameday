# FieldView Runtime Development

The initial Cloudflare runtime is isolated under `workers/fieldview-runtime`. It is not connected to production traffic and has no configured Cloudflare credentials. Public event snapshots and read-only live subscriptions do not require user authentication; only internal administration and service-to-service operations use the runtime admin token.

## Runtime secrets and configuration

Configure secrets as Cloudflare Worker secrets; never commit their values:

- `TBA_API_KEY` — TBA v3 read API key used by EventRuntime polling.
- `TBA_WEBHOOK_SECRET` — the secret configured for the TBA webhook; used to verify `X-TBA-HMAC`.
- `RUNTIME_ADMIN_TOKEN` — high-entropy internal bearer token for administrative scheduling/state routes and Worker-to-DO calls.

Optional non-secret variables:

- `TBA_AUTHORITATIVE_REFETCH_DELAY_MS` — non-negative delay (default 65000 ms) for the one-shot authoritative TBA REST refetch after the immediate webhook-triggered refresh.
- `STATBOTICS_REFRESH_DELAY_MS` — non-negative delay (default 300000 ms) before the one-shot Statbotics enrichment request after a changed TBA REST representation.
- `EVENT_DISCOVERY_INTERVAL_MS` — global TBA event discovery cadence (default 3600000 ms / 1 hour).
- `EVENT_UPCOMING_INTERVAL_MS` — polling cadence for upcoming-event resources (default 1800000 ms / 30 minutes).
- `EVENT_ACTIVE_INTERVAL_MS` — polling cadence for live match/status/alliance/OPR/prediction resources during active events (default 300000 ms / 5 minutes).
- `EVENT_COMPLETED_RETENTION_MS` — how long completed events remain scheduled (default 86400000 ms / 24 hours).

Statbotics currently requires no API credential.

For local development, use Wrangler's local secret workflow. For a future remote environment, set each secret explicitly for that environment before deploying. No secret values are stored in this repository.

## Worker routes

- `GET /health` — liveness response.
- `POST /webhooks/tba` — public TBA webhook ingress. Verifies HMAC-SHA256 over the exact raw request body before parsing JSON. Payloads are capped at 1 MB. TBA ping and verification notifications receive a 200 response; event notifications are routed to the EventRuntime named by the unchanged TBA event key.
- `POST /internal/events/:eventKey/schedule` — authenticated administrative scheduling. Body: `{ "endpoints": ["/event/..."], "intervalMs": 60000 }`. Endpoints must be in the EventRuntime's event-scoped TBA endpoint allowlist; Statbotics cannot be scheduled administratively.
- `POST /internal/scheduler/start` / `stop`, `GET /internal/scheduler/state` — authenticated controls for the global durable event-discovery scheduler. Start performs discovery immediately, then repeats at the configured cadence. The scheduler is intentionally not auto-started by a Cron Trigger.
- `GET /internal/events/:eventKey/state` — authenticated inspection of current endpoint state.
- `GET /events/:eventKey/snapshot` — public, read-only canonical `FieldViewEventSnapshot`. No user login or browser-held service credential is required. The response exposes `X-FieldView-Snapshot-Version` and permits cross-origin browser reads; it is not cacheable at the Worker edge.
- `GET /events/discovery?year=YYYY` — public, read-only array of normalized `FieldViewEvent` objects from the global EventScheduler's durable TBA discovery cache. It does not trigger an upstream request; it returns 503 until that year's cache has been populated. Payload provenance is `available` after recent successful validation and `stale` after two missed discovery intervals.
- `GET /stream` — public, read-only WebSocket to the single shared Multiplexer Durable Object. Browser clients send validated `subscribe` / `unsubscribe` messages for `event-state` or `analytics` topics and `ping` for keepalive. The multiplexer serves multiple clients, deduplicates event-state registration with EventRuntime, and forwards revision-only notifications only to subscribed clients. The analytics topic is reserved in the protocol until its authoritative publisher is connected.
- `GET /events/:eventKey/stream?since=:version` — temporary public, read-only event-scoped compatibility stream. The shared `/stream` route is the intended browser integration path; clients fetch the canonical snapshot after a gap or newer revision.
- `OPTIONS /events/:eventKey/snapshot` — CORS preflight for public snapshot reads.
- `GET /internal/events/:eventKey/snapshot` — authenticated administrative/internal canonical snapshot route (retained for service-side inspection).

The multiplexer calls EventRuntime's internal `POST /subscriptions` operation to register or unregister its shared subscriber identity. Each request carries a monotonically increasing generation for that event; EventRuntime persists the newest generation and ignores stale out-of-order requests. The multiplexer reconciles desired upstream state after each client subscription-set change. EventRuntime sends `snapshot.changed` revision metadata to the multiplexer only while that registration is active. The multiplexer accepts internal `POST /internal/notify` deliveries only with the service bearer token; these internal DO-to-DO paths are not exposed as public Worker routes.

## Frontend integration

Server-rendered event pages and the events browser can use the optional server-only `FIELDVIEW_RUNTIME_URL` base origin. When configured, the event page reads its canonical snapshot and uses it only when the resources required by the selected tab have been acquired. The events browser reads normalized `FieldViewEvent` discovery records from the global scheduler cache. Missing event snapshot fields fall back to the existing TBA read path; explicit `null` values remain explicit unavailable data rather than being silently replaced. If the discovery cache is cold or unavailable, the events page normalizes its server-side TBA fallback before passing data to the client. No production value is configured.

### SharedWorker integration

The existing SharedWorker has an opt-in canonical runtime transport. Set the web application's build-time `NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL` to the Cloudflare Worker base origin to enable it. The SharedWorker then uses its single browser WebSocket connection for the public `/stream` multiplexer, replays event-state subscriptions after reconnect, and fetches versioned canonical snapshots from `/events/:eventKey/snapshot` after subscription acknowledgement, reconnect, or a newer revision notification.

New consumers can use `getCanonicalEventSnapshot` and `subscribeCanonicalEventSnapshot` from `apps/web/src/lib/events/sharedWorkerClient.ts`. The canonical snapshot is the `@fieldview/domain` `FieldViewEventSnapshot`, not a second client DTO. Snapshot versions are compared before replacing cached state so an older in-flight response cannot overwrite a newer snapshot.

When `NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL` is unset, the SharedWorker retains its existing Vercel WebSocket behavior. When enabled, existing `EventState` consumers still use their legacy REST read path as a temporary compatibility layer and respond to runtime revision notifications by refreshing that path; the new canonical snapshot API is available for incremental UI migration. No production URL is configured and no production UI cutover has occurred. The event detail page and events browser now have opt-in canonical read paths; this setting must not be enabled in production before deployment and explicit cutover approval. Analytics subscription/recovery remains pending until the authoritative analytics publisher and result endpoint are connected.

## Ownership and data handling

Each event maps to one EventRuntime Durable Object. It owns endpoint validators, the exact latest HTTP representation (`providerData`), the locally reconciled endpoint value (`data`), immutable accepted-200 source versions, raw webhook deliveries, and event-scoped poll tasks. One global EventScheduler Durable Object discovers the prior, current, and next competition years hourly using ETags, then assigns lifecycle-aware schedules. TBA date-only event boundaries are interpreted in each event's IANA timezone (including DST); the TBA end date is inclusive. A 304 updates the successful validation time without replacing the retained payload version, and discovery provenance becomes stale after two missed validation intervals. Upcoming event resources poll every 30 minutes; during an active event, match/status/alliance/OPR/prediction resources poll every 5 minutes while other event resources remain at 30 minutes. Completed events retain the active schedule for 24 hours after the inclusive TBA end-date boundary, then recurring TBA polls stop.

A webhook never changes an HTTP ETag or its corresponding `providerData`. Full match-score/video notifications update the local match list using the unchanged TBA match record; schedule/upcoming-match notifications trigger an immediate matches refresh; alliance-selection and awards notifications trigger their corresponding refreshes. Other notification payloads are retained without inventing an update. For webhook types that trigger REST refreshes, the runtime performs the immediate refresh and retains a one-shot authoritative refetch 65 seconds later by default (`TBA_AUTHORITATIVE_REFETCH_DELAY_MS`); this gives TBA's REST API time to catch up without introducing a recurring 65-second poll. The delayed follow-up remains separate from the downstream Statbotics settling delay.

Duplicate identical payloads are idempotently ignored using a SHA-256 digest of the raw body. Failed polling preserves the last good endpoint representation and validator. A single Durable Object alarm services event-scoped tasks. TBA polling intervals are explicitly supplied by the scheduler; webhook-triggered TBA one-off polls retry until successful. Statbotics is never independently polled: an accepted change to the TBA event, team, team-status, or match REST representation schedules a debounced Statbotics match refresh. The default debounce is five minutes and is configurable with `STATBOTICS_REFRESH_DELAY_MS`. Each TBA-triggered refresh allows at most four attempts (one initial request plus three bounded retries on provider failure or HTTP 304); retry exhaustion ends that trigger, and a later changed TBA representation may trigger another refresh. Failed attempts preserve the last good representation.

## Local validation

From the repository root:

- `npm test` runs domain, TBA provider, endpoint-state, reconciliation, source-version, and webhook-signature tests.
- `npm run typecheck` also typechecks the Worker entrypoint and EventRuntime adapter.

The canonical snapshot includes TBA matches and playoff alliance associations, plus the unchanged Statbotics event-match collection associated by exact match key. Statbotics match data retains independent prediction and EPA fields with its own source metadata. Statbotics is refreshed only once after a changed TBA REST representation, never on a recurring schedule. Analytics recalculation remains a separate downstream batch concern; the proposed initial cadence is ten minutes as the initial target, with five minutes as a possible more-responsive setting, and does not alter analytics semantics. The Wrangler config declares SQLite-backed EventRuntime, Multiplexer, and EventScheduler Durable Objects and intentionally has no production routes, Cron Triggers, or deployment settings yet. The lifecycle scheduler must be explicitly started through its authenticated control route after a future deployment; no production deployment or scheduler activation is performed by this change.