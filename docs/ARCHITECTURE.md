# FieldView Architecture

## Ownership boundaries

### Cloudflare Runtime Worker

`workers/fieldview` is the only backend deployment boundary. It composes Runtime HTTP/WebSocket routes and Workflow entrypoints in one environment-neutral Worker named `runtime`.

### EventRuntime and TeamRuntime

The Durable Objects persist provider endpoint records, including response payloads, ETags, Last-Modified values, freshness metadata, revisions, and acquisition status. They do not require a precomputed normalized publication to be initialized.

A client read derives an ephemeral EventState or TeamState from the available endpoint records. In-memory materialization is an optional hot cache keyed by the source-record signature. If the object is evicted or the cache is absent, the projection is regenerated. Read paths are storage-read-only: no `put`, `delete`, alarm scheduling, or implicit refresh.

Explicit refresh, webhook reconciliation, and bootstrap operations may write provider endpoint records. Workflows own acquisition and scheduling; Durable Objects own scoped provider data and projection logic.

### Discovery and system records

D1 repositories own discovery directories and operational/system records. KV holds only lightweight, non-authoritative projections or canonical pointers. Durable Object SQLite owns event/team provider resources. No R2 storage is part of the target.

### Jobs and polling

Cloudflare Workflows coordinate season discovery, event/team readiness, bootstrap, analytics, admin operations, and the polling coordinator. The Worker cron handler starts the appropriate Workflow. There is no legacy Queue consumer or producer and no DO alarm polling.

### Realtime

The browser SharedWorker maintains one Worker `/stream` connection for the browser origin and multiplexes canonical EventRuntime snapshot and analytics subscriptions to tabs. The Worker Multiplexer coordinates subscriptions and data-bearing publications. On reconnect, the browser recovers snapshots through the canonical Worker endpoints. Browser code does not acquire TBA, Statbotics, or FRC Colors resources.

### Webhooks

TBA sends signed webhook requests directly to `POST /webhooks/tba` on the Worker. The Worker verifies the raw-body HMAC and dispatches event-scoped reconciliation. No Vercel webhook relay or Redis Pub/Sub bridge exists.

### Remote sessions

RemoteSessionRuntime handles pairing-scoped WebRTC signaling through hibernatable Durable Object WebSockets. Presence is derived from accepted sockets and their serialized attachments; no Redis lease, heartbeat, or alarm is needed.

## Frontend

The Next.js application remains hosted on Vercel. It consumes FieldView domain contracts from the Worker and may provide thin same-origin presentation adapters, but Vercel does not own provider clients, persistent application data, realtime delivery, or workflow orchestration.

## Deployment model

There is one Wrangler configuration at `workers/fieldview/wrangler.toml`. Top-level bindings define the eventual production Worker. The `previews` configuration provides isolated branch/PR Preview bindings. Do not use Wrangler named environments or add separate Worker identities for preview/staging/production.

The migration branch has not been deployed. Preview deployment and clean-resource integration testing are the next operational gate; merge to `main` and production deployment are later, explicit steps.
