# FieldView runtime

This document describes the final migration architecture on `fieldview-architecture-migration`. It replaces older notes about Redis, Vercel WebSockets, R2-compatible discovery objects, per-event WebSocket routes, and persisted normalized-state publications.

## Deployment shape

- The backend is one environment-neutral Cloudflare Worker named `runtime`.
- Worker source and configuration live in `workers/fieldview`, with one `wrangler.toml` and one local `.dev.vars`.
- Wrangler named environments are not used. Production configuration is top-level; branch and PR Preview URLs use `preview_urls = true`.
- The Next.js frontend remains on Vercel. Its runtime URL is configured separately in the Vercel project; frontend environment variables do not belong in the Worker `.dev.vars`.
- No branch resources have been deployed. There is no production data, queue backlog, Redis state, or legacy runtime state to migrate or preserve.

## Cloudflare resource ownership

| Resource | Responsibility |
|---|---|
| Durable Objects | EventRuntime, TeamRuntime, Multiplexer, RemoteSessionRuntime, and TaskScheduler |
| D1 | Discovery records and operational/system records |
| KV | Small, disposable projections and canonical pointers only |
| Workflows | Discovery, endpoint bootstrap/readiness, polling orchestration, analytics, and administrative operations |
| Worker Static Assets | Cloudflare admin dashboard |
| Cron Triggers | Start coordinator/workflow work; they do not poll providers from Durable Object alarms |

There is no R2 binding, Cloudflare Queue producer or consumer, Redis binding, or Durable Object alarm polling. Discovery records are accessed through typed in-process D1 JSON-record methods. The old generic R2-shaped `/get`, `/put`, and `/list` HTTP API is not part of the runtime.

## Durable source data and normalized read contracts

EventRuntime owns event-scoped provider endpoint records, including TBA and Statbotics response data, validators, acquisition status, freshness, and revisions.

TeamRuntime owns team/year-scoped provider endpoint records and their acquisition metadata.

The provider endpoint records are the durable source of truth. EventState and TeamState are normalized client-facing read models:

1. A client requests `GET /events/:eventKey/snapshot` or `GET /teams/:teamKey/snapshot?year=YYYY`.
2. The owning Durable Object reads its endpoint records and constructs the requested normalized projection.
3. A disposable in-memory hot cache may be reused while its source signature matches.
4. The read returns the projection without writing Durable Object storage or acquiring provider data.

The current implementation does not persist normalized EventState or TeamState. Cache eviction simply causes the next read to rebuild from provider endpoint records. Bootstrap workflows acquire missing provider resources only; they do not pre-generate normalized state to make an initial read possible.

Analytics publications and TeamEventState records are separate analytics data with their own persistence contracts. They do not make an EventState or TeamState publication mandatory.

## Provider acquisition and polling

- Workflows bootstrap missing endpoint resources.
- The polling coordinator owns ongoing cadence and dispatch.
- EventRuntime and TeamRuntime do not register alarm handlers or schedule Durable Object alarms.
- A public snapshot read never calls TBA, Statbotics, or FRC Colors and never dispatches a workflow.
- Explicit refresh and webhook operations may mutate provider endpoint records and revisions.
- TBA webhooks enter through the Worker at `POST /webhooks/tba`; signature verification uses the raw request body and `TBA_WEBHOOK_SECRET`.

The current polling policy is centralized in the jobs layer. It is not duplicated as per-DO timers or alarm polling.

## HTTP and realtime routes

Canonical reads:

- `GET /events/:eventKey/snapshot`
- `GET /teams/:teamKey/snapshot?year=YYYY`
- `GET /events/:eventKey/analytics`
- `GET /teams/:teamKey/season-analytics?year=YYYY`
- `GET /events/:eventKey/statbotics-match?match_key=...`
- `GET /events/discovery?year=YYYY`
- `GET /teams/discovery?year=YYYY`

Realtime:

1. The browser fetches the canonical HTTP snapshot first.
2. The SharedWorker opens the single public `/stream` WebSocket, owned by Multiplexer.
3. EventState snapshot changes, team-event patches, and analytics changes are sent as data-bearing notifications.
4. The SharedWorker applies valid notifications to its in-memory cache.
5. Reconnect restores subscriptions only. WebSocket acknowledgements, notifications, gaps, and reconnects do not trigger HTTP snapshot or analytics refetches.

There is no per-event EventRuntime WebSocket endpoint. The SharedWorker does not persist normalized snapshots in IndexedDB. An explicit user refresh or a new client read may make another HTTP request.

## Local configuration

From the repository root:

```sh
cp workers/fieldview/.dev.vars.example workers/fieldview/.dev.vars
npm run dev:worker
```

Set the actual local secrets in `workers/fieldview/.dev.vars`:

- `TBA_API_KEY`
- `TBA_WEBHOOK_SECRET`
- `RUNTIME_ADMIN_TOKEN`
- `STATBOTICS_API_BASE_URL` when using a non-default Statbotics endpoint

The frontend separately needs `NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL` in its Vercel environment. Do not duplicate Worker secrets into the frontend.

## Final integration gate

Before merging to `main`, validate a clean Cloudflare Preview deployment end to end:

1. Apply and verify the D1 migrations and bindings.
2. Deploy the Worker Preview and verify all configured DO, D1, KV, Workflow, Cron, and Static Asset bindings.
3. Run provider bootstrap and confirm endpoint records are written.
4. Read event and team snapshots cold, warm, and after DO eviction; verify reads produce normalized state without Durable Object writes.
5. Verify polling and webhook updates reach the correct runtime records.
6. Verify browser order is snapshot then stream, data-bearing WSS updates apply, and no WSS message or reconnect causes an HTTP refetch.
7. Inspect Durable Object write counts and confirm no alarm polling or queue traffic.

This branch has not been deployed. Successful repository CI is not a substitute for the Preview end-to-end gate. Production deployment and merge remain separate, explicit steps.
