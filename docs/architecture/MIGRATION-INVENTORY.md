# Final Architecture Inventory

**Branch:** `fieldview-architecture-migration`  
**Purpose:** Record the target implementation, not the pre-migration application inventory.

## Deployable components

| Component | Target responsibility |
|---|---|
| `apps/web` | Next.js frontend hosted on Vercel; consumes canonical Worker contracts |
| `workers/fieldview` | Single environment-neutral Cloudflare Worker named `runtime` |
| EventRuntime DO | Event-scoped provider endpoint records, validators, reconciliation, read-time EventState projection, event publications |
| TeamRuntime DO | Team-season provider endpoint records and read-time TeamState projection |
| Multiplexer DO | Canonical snapshot and analytics subscription/publication coordination |
| RemoteSessionRuntime DO | Pairing-scoped WebRTC signaling over hibernatable WebSockets |
| D1 | Discovery directories and operational/system records |
| KV | Lightweight projections and canonical pointers only |
| Workflows | Season discovery, readiness/bootstrap, polling, analytics, coverage, and admin orchestration |
| Worker cron | Starts scheduled Workflows; no DO alarms or Queue consumer |
| Worker Static Assets | Runtime admin dashboard |

## Data contract

Provider endpoint payloads and their acquisition metadata are the durable source of truth in EventRuntime and TeamRuntime. EventState and TeamState are normalized read models, not bootstrap artifacts or mandatory persisted records.

A read may use a matching in-memory projection cache. Otherwise it creates a fresh projection from stored endpoint records. Projection creation is ephemeral and must not write to DO storage. Provider acquisition and explicit reconciliation are the only paths that update provider endpoint records.

## Public runtime interfaces

- Event snapshot: `GET /events/{eventKey}/snapshot`
- Team snapshot: `GET /teams/{teamKey}/snapshot?year={year}`
- Realtime stream: `/stream` after the initial canonical HTTP snapshot fetch
- TBA webhook ingress: `POST /webhooks/tba`
- Remote signaling: `/remote/ws`
- Discovery, analytics, readiness, and admin interfaces are exposed by the Runtime Worker routes.

## Retired dependencies and interfaces

No web-side Redis/ioredis provider cache, Redis Pub/Sub, Vercel WebSocket endpoint, Vercel TBA webhook relay, legacy web provider clients, legacy browser EventState polling, queue producer/consumer, or Durable Object alarm polling remains in the target. No R2 binding is configured.

## Environment and configuration

- One Wrangler file: `workers/fieldview/wrangler.toml`.
- One Worker identity: `runtime`.
- Local Worker variables/secrets: `workers/fieldview/.dev.vars`.
- Frontend deployment variables: Vercel project configuration.
- Preview resources use explicit isolated D1/KV/DO bindings.
- No Wrangler named environments.

## Deployment status

No Worker, Durable Object, D1, KV, or Workflow resources from this branch have been deployed. The branch is not merged to `main`. Final integration testing must start from clean resources; there is no old queue or production state to migrate.
