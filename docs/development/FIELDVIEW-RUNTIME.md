# FieldView Runtime Development

The initial Cloudflare runtime is isolated under `workers/fieldview-runtime`. It is not connected to production traffic and has no configured Cloudflare credentials. Public event snapshots and read-only live subscriptions do not require user authentication; only internal administration and service-to-service operations use the runtime admin token.

## Runtime secrets and configuration

Configure secrets as Cloudflare Worker secrets; never commit their values:

- `TBA_API_KEY` — TBA v3 read API key used by EventRuntime polling.
- `TBA_WEBHOOK_SECRET` — the secret configured for the TBA webhook; used to verify `X-TBA-HMAC`.
- `RUNTIME_ADMIN_TOKEN` — high-entropy internal bearer token for administrative scheduling/state routes and Worker-to-DO calls.

Optional non-secret variables:

- `STATBOTICS_REFRESH_DELAY_MS` — non-negative delay (default 300000 ms) before the one-shot Statbotics enrichment request after a changed TBA REST representation.

Statbotics currently requires no API credential.

For local development, use Wrangler's local secret workflow. For a future remote environment, set each secret explicitly for that environment before deploying. No secret values are stored in this repository.

## Worker routes

- `GET /health` — liveness response.
- `POST /webhooks/tba` — public TBA webhook ingress. Verifies HMAC-SHA256 over the exact raw request body before parsing JSON. Payloads are capped at 1 MB. TBA ping and verification notifications receive a 200 response; event notifications are routed to the EventRuntime named by the unchanged TBA event key.
- `POST /internal/events/:eventKey/schedule` — authenticated administrative scheduling. Body: `{ "endpoints": ["/event/..."], "intervalMs": 60000 }`. Endpoints must be in the EventRuntime's event-scoped TBA endpoint allowlist; Statbotics cannot be scheduled administratively.
- `GET /internal/events/:eventKey/state` — authenticated inspection of current endpoint state.
- `GET /events/:eventKey/snapshot` — public, read-only canonical `FieldViewEventSnapshot`. No user login or browser-held service credential is required. The response exposes `X-FieldView-Snapshot-Version` and permits cross-origin browser reads; it is not cacheable at the Worker edge.
- `GET /events/:eventKey/stream?since=:version` — public, read-only WebSocket revision subscription. Clients fetch the public snapshot after a gap or newer revision; the stream never accepts mutation commands.
- `OPTIONS /events/:eventKey/snapshot` — CORS preflight for public snapshot reads.
- `GET /internal/events/:eventKey/snapshot` — authenticated administrative/internal canonical snapshot route (retained for service-side inspection).

## Ownership and data handling

Each event maps to one EventRuntime Durable Object. It owns endpoint validators, the exact latest HTTP representation (`providerData`), the locally reconciled endpoint value (`data`), immutable accepted-200 source versions, raw webhook deliveries, and event-scoped poll tasks.

A webhook never changes an HTTP ETag or its corresponding `providerData`. Full match-score/video notifications update the local match list using the unchanged TBA match record; schedule/upcoming-match notifications trigger an immediate matches refresh; alliance-selection and awards notifications trigger their corresponding refreshes. Other notification payloads are retained without inventing an update.

Duplicate identical payloads are idempotently ignored using a SHA-256 digest of the raw body. Failed polling preserves the last good endpoint representation and validator. A single Durable Object alarm services event-scoped tasks. TBA polling intervals are explicitly supplied by the scheduler; webhook-triggered TBA one-off polls retry until successful. Statbotics is never polled: an accepted change to the TBA event, team, team-status, or match REST representation schedules a debounced, at-most-once Statbotics match fetch. The default debounce is five minutes and is configurable with `STATBOTICS_REFRESH_DELAY_MS`. A failed or not-yet-updated Statbotics response preserves the last good representation and is not retried; a later changed TBA representation may trigger another one-shot request.

## Local validation

From the repository root:

- `npm test` runs domain, TBA provider, endpoint-state, reconciliation, source-version, and webhook-signature tests.
- `npm run typecheck` also typechecks the Worker entrypoint and EventRuntime adapter.

The canonical snapshot includes TBA matches and playoff alliance associations, plus the unchanged Statbotics event-match collection associated by exact match key. Statbotics match data retains independent prediction and EPA fields with its own source metadata. Statbotics is refreshed only once after a changed TBA REST representation, never on a recurring schedule. Analytics recalculation remains a separate downstream batch concern; the proposed initial cadence is ten minutes as the initial target, with five minutes as a possible more-responsive setting, and does not alter analytics semantics. The Wrangler config uses a SQLite-backed Durable Object migration and intentionally has no routes, Cron Triggers, or production deployment settings yet.