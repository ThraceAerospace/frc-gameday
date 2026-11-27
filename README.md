# FieldView

FieldView is a data application for FIRST Robotics Competition. It acquires upstream competition data, stores provider resources in Cloudflare Durable Objects, derives normalized FieldView state on demand, and serves that state to web and realtime clients.

## Architecture at a glance

- **Web application:** Next.js in `apps/web`, hosted on Vercel. Vercel hosts the frontend; it is not a provider-data, persistence, orchestration, webhook, or realtime backend.
- **Runtime:** one environment-neutral Cloudflare Worker named `runtime`, implemented in `workers/fieldview` and configured by its single `wrangler.toml`. Production uses top-level configuration. Branch and pull-request validation uses Cloudflare Workers Preview URLs and Preview bindings, not Wrangler named environments.
- **Runtime ownership:** one EventRuntime Durable Object owns each event; one TeamRuntime owns each team. Each runtime owns its provider requests, validators, endpoint records, reconciliation, persistence, freshness, and publications for its scope.
- **Durable provider data:** provider endpoint responses and acquisition metadata are the canonical durable inputs. EventState and TeamState are normalized, client-facing projections built from those records when read; they are not persisted.
- **Initialization:** a Workflow may perform a one-time, bounded provider acquisition when a runtime is first registered/created, to ensure reliable initial hydration. After bootstrap, provider acquisition and refresh belong to the owning runtime.
- **Reads:** public snapshot reads are read-only. They do not fetch providers, start workflows, mutate readiness, or write Durable Object storage. A cold read derives the projection from durable provider endpoint records; an optional in-memory projection cache is disposable.
- **Orchestration:** Cloudflare Workflows own durable multi-step jobs such as discovery, first-time runtime initialization, season ingestion, analytics, and administrative operations. The Worker-level polling coordinator selects eligible runtime identities and dispatches bounded refresh commands; it does not proxy provider requests.
- **Realtime:** clients obtain an HTTP snapshot first, then subscribe through the single Multiplexer-owned `/stream` WebSocket. Notifications carry the changed state data (or the committed analytics publication), not merely a revision/invalidation. The SharedWorker applies ordered updates in memory. Notifications, gaps, and reconnects do not trigger hidden HTTP refetches.
- **Storage:** Durable Object SQLite owns runtime-scoped canonical provider records and runtime data. D1 owns discovery and operational/system records. KV is limited to small, non-authoritative projections and pointers. R2, Redis, and Cloudflare Queues are not part of the architecture.
- **Webhooks:** TBA sends directly to the Worker's `/webhooks/tba` ingress. There is no Vercel relay or Redis Pub/Sub layer.
- **Remote display:** RemoteSessionRuntime owns remote-session signaling over Durable Object WebSockets.

## Repository layout

- `apps/web` — Next.js frontend and reusable UI/domain consumers.
- `apps/admin-cloudflare` — Cloudflare Worker admin asset build.
- `workers/fieldview/src/runtime` — HTTP routing, Durable Objects, provider-resource ownership, snapshot projection, realtime multiplexing, webhook ingress, and remote sessions.
- `workers/fieldview/src/jobs` — Workflows, discovery/season orchestration, polling coordination, analytics jobs, and runtime initialization.
- `packages/domain` — canonical FieldView domain objects, normalized client-facing contracts, and domain rules.
- `packages/providers/*` — provider clients, generated schemas, and transport-specific behavior.
- `packages/analytics` — reusable analytics calculations independent of UI and runtime transport.

## Local development

Install dependencies:

```bash
npm ci
```

Copy the Worker local variables template and start the Worker:

```bash
cp workers/fieldview/.dev.vars.example workers/fieldview/.dev.vars
npm run dev:worker
```

Start the web application separately:

```bash
npm run dev
```

Worker secrets belong in `workers/fieldview/.dev.vars`. Frontend variables belong in the Vercel project configuration. Do not put Worker secrets in browser-visible variables or create an additional root environment file.

## Validation

Use the repository scripts as the source of truth:

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

Before production cutover, validate the clean Preview resource baseline, first-time runtime bootstrap, read-time projections and zero-write reads, polling, analytics, data-bearing realtime updates, webhook authentication, and remote-session signaling. Passing repository CI is necessary but does not replace deployed Preview integration testing.

## Architecture references

- [Architecture overview](docs/ARCHITECTURE.md)
- [Runtime and data lifecycle](docs/development/FIELDVIEW-RUNTIME.md)
- [Cloudflare deployment model](docs/development/CLOUDFLARE-ENVIRONMENTS.md)
- [EventState and analytics contracts](docs/EVENT-STATE-AND-ANALYTICS.md)
- [Architecture decisions](docs/architecture/decisions/)
- [Production integration and cutover gate](docs/architecture/MIGRATION-PLAN.md)
