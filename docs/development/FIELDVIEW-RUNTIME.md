# FieldView Runtime Development

The initial Cloudflare runtime is isolated under `workers/fieldview-runtime`. It is not connected to production traffic and has no configured Cloudflare credentials.

## Required runtime secrets

Configure these as Cloudflare Worker secrets; never commit their values:

- `TBA_API_KEY` — TBA v3 read API key used by EventRuntime polling.
- `STATBOTICS_REFRESH_DELAY_MS` — optional non-negative delay (default 300000 ms) before a one-shot Statbotics enrichment request after a changed TBA REST representation. This is configuration, not a credential.
- Statbotics currently requires no API credential; EventRuntime uses the provider-owned v3 transport only for TBA-change-triggered one-shot enrichment.
- `TBA_WEBHOOK_SECRET` — the secret configured for the TBA webhook; used to verify `X-TBA-HMAC`.
- `RUNTIME_ADMIN_TOKEN` — high-entropy internal bearer token for administrative scheduling/state routes and Worker-to-DO calls.

For local development, use Wrangler's local secret workflow. For a future remote environment, set each secret explicitly for that environment before deploying. No secret values are stored in this repository.

## Worker routes

- `GET /health` — liveness response.
- `POST /webhooks/tba` — public TBA webhook ingress. Verifies HMAC-SHA256 over the exact raw request body before parsing JSON. Payloads are capped at 1 MB. TBA ping and verification notifications receive a 200 response; event notifications are routed to the EventRuntime named by the unchanged TBA event key.
- `POST /internal/events/:eventKey/schedule` — authenticated administrative scheduling. Body: `{ "endpoints": ["/event/..."], "intervalMs": 60000 }`. Endpoints must be in the EventRuntime's event-scoped TBA endpoint allowlist; Statbotics cannot be scheduled administratively.
- `GET /internal/events/:eventKey/state` — authenticated inspection of current endpoint state.
- `GET /internal/events/:eventKey/snapshot` — authenticated canonical `FieldViewEventSnapshot` composed from acquired event, team, team-status, match, event-prediction, OPR, playoff-alliance, and Statbotics match resources.

## Ownership and data handling

Each event maps to one EventRuntime Durable Object. It owns endpoint validators, the exact latest HTTP representation (`providerData`), the locally reconciled endpoint value (`data`), immutable accepted-200 source versions, raw webhook deliveries, and event-scoped poll tasks.

A webhook never changes an HTTP ETag or its corresponding `providerData`. Full match-score/video notifications update the local match list using the unchanged TBA match record; schedule/upcoming-match notifications trigger an immediate matches refresh; alliance-selection and awards notifications trigger their corresponding refreshes. Other notification payloads are retained without inventing an update.

Duplicate identical payloads are idempotently ignored using a SHA-256 digest of the raw body. Failed polling preserves the last good endpoint representation and validator. A single Durable Object alarm services event-scoped tasks. TBA polling intervals are explicitly supplied by the scheduler; webhook-triggered TBA one-off polls retry until successful. Statbotics is never polled: an accepted change to the TBA event, team, team-status, or match REST representation schedules a debounced, at-most-once Statbotics match fetch. The default debounce is five minutes and is configurable with `STATBOTICS_REFRESH_DELAY_MS`. A failed or not-yet-updated Statbotics response preserves the last good representation and is not retried; a later changed TBA representation may trigger another one-shot request.

## Local validation

From the repository root:

- `npm test` runs domain, TBA provider, endpoint-state, reconciliation, source-version, and webhook-signature tests.
- `npm run typecheck` also typechecks the Worker entrypoint and EventRuntime adapter.

The canonical snapshot includes TBA matches and playoff alliance associations, plus the unchanged Statbotics event-match collection associated by exact match key. Statbotics match data retains independent prediction and EPA fields with its own source metadata. Statbotics is refreshed only once after a changed TBA REST representation, never on a recurring schedule. Analytics recalculation remains a separate downstream batch concern; the proposed initial cadence is ten minutes, configurable down to five minutes, and does not alter analytics semantics. The Wrangler config uses a SQLite-backed Durable Object migration and intentionally has no routes, Cron Triggers, or production deployment settings yet.