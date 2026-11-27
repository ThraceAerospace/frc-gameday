# FieldView runtime

This document describes the runtime lifecycle defined by ADR-0020.

## Deployment shape

- One environment-neutral Cloudflare Worker named `runtime`.
- One Worker project under `workers/fieldview`, one `wrangler.toml`, and one local `.dev.vars`.
- Production uses the top-level Wrangler configuration. Branch and pull-request validation uses Workers Preview URLs and Preview bindings in the same configuration; Wrangler named environments are not used.
- The Next.js frontend is hosted separately on Vercel. Vercel does not own provider acquisition, runtime persistence, orchestration, webhooks, or realtime.
- Runtime source is organized into `src/runtime` and `src/jobs` modules composed by the Worker entrypoint.

## Runtime responsibilities

| Component | Responsibility |
|---|---|
| EventRuntime | Event-scoped provider endpoint records, validators, freshness, reconciliation, canonical event data, and event-wide analytics |
| TeamRuntime | Team/year-scoped provider endpoint records, validators, freshness, reconciliation, canonical team data, team-event state, and team analytics |
| Multiplexer | The single public `/stream` WebSocket and shared subscription coordination |
| RemoteSessionRuntime | Remote display session signaling and session lifecycle |
| Polling coordinator | Lifecycle cadence, target selection, prioritization, bounded concurrency, overlap prevention, and dispatch of refresh commands |
| Workflows | Durable discovery, first-registration bootstrap, season ingestion, analytics, and administrative orchestration |
| D1 repositories | Discovery catalog and operational/system records |
| KV | Small disposable projections and canonical pointers only |

Durable Object alarm polling, Cloudflare Queue refresh paths, Redis, and R2 are not part of this runtime.

## Provider acquisition lifecycle

### First registration

When an event or team is first registered/created, its initialization Workflow may perform one bounded acquisition of the provider endpoint resources needed to hydrate the new runtime. It passes those endpoint records to the owning Durable Object for persistence. This is an intentional one-time exception to runtime-owned acquisition, retained to make first-time hydration reliable.

The bootstrap operation:
- is tied to first registration/creation;
- is idempotent and bounded;
- persists provider endpoint records and their validators/status/freshness metadata;
- does not generate or persist EventState or TeamState;
- is not used as a recurring refresh path.

### Normal operation

After bootstrap, the owning runtime is the only component that performs ongoing provider requests for its scope. The polling coordinator selects eligible runtimes and sends explicit refresh commands. The runtime fetches provider resources, applies validators, reconciles results, persists meaningful changes, and publishes its updated state. Explicit administrative refreshes and authenticated webhook follow-up may also dispatch runtime-owned work.

The coordinator and Workflows may orchestrate work, but must not repeatedly fetch provider resources on behalf of initialized runtimes.

## Read lifecycle

Canonical public reads include:

- `GET /events/:eventKey/snapshot`
- `GET /teams/:teamKey/snapshot?year=YYYY`
- `GET /events/:eventKey/analytics`
- `GET /teams/:teamKey/season-analytics?year=YYYY`

For an EventState or TeamState snapshot, the owning runtime reads its durable provider endpoint records and derives the normalized projection. A disposable in-memory hot cache may be reused when the source signature matches. A cold read or cache eviction simply recomputes the projection.

Snapshot reads:
- do not call TBA, Statbotics, or FRC Colors;
- do not register or initialize runtimes;
- do not start Workflows or dispatch refreshes;
- do not mutate Durable Object storage.

Analytics publications have their own persistence and revision contract. They are not a prerequisite for deriving EventState or TeamState.

## Polling and orchestration

The polling coordinator is a Worker/Jobs responsibility. It evaluates lifecycle policy, selects event/team targets, applies concurrency and request budgets, prevents overlapping refreshes, and dispatches explicit commands. It does not make provider requests.

Workflows own durable multi-step orchestration. First-registration bootstrap is the only permitted Workflow-owned provider acquisition and must not become recurring behavior.

EventRuntime and TeamRuntime do not register Durable Object alarm handlers and do not schedule alarms. There is no Queue producer/consumer in the refresh path.

## HTTP and realtime lifecycle

1. A client reads the canonical HTTP event/team snapshot.
2. The browser SharedWorker opens or reuses the single Multiplexer-owned `/stream` WebSocket and registers subscriptions.
3. Runtime state changes are published as data-bearing messages containing the changed EventState snapshot or team-event patch/data plus scope and revision metadata.
4. Analytics changes carry the committed analytics publication plus revision metadata.
5. The SharedWorker applies valid, ordered messages to its in-memory cache and fans them out to clients.
6. Reconnect restores subscriptions only.

Revision-only invalidations are not valid state updates. A notification, acknowledgement, sequence gap, disconnect, or reconnect must never trigger an HTTP snapshot or analytics refetch. A new client/page read or explicit user refresh may perform a new HTTP request. Normalized snapshots are not persisted in browser IndexedDB.

## Webhooks

TBA webhooks enter directly through `POST /webhooks/tba`. The Worker verifies the signature against the raw request body using `TBA_WEBHOOK_SECRET`, validates the event identity, and routes the change to the owning EventRuntime. No Vercel relay or Redis Pub/Sub layer is involved.

## Local configuration

```sh
cp workers/fieldview/.dev.vars.example workers/fieldview/.dev.vars
npm run dev:worker
```

The Worker local file contains server-side secrets and configuration such as `TBA_API_KEY`, `TBA_WEBHOOK_SECRET`, and admin credentials. Frontend runtime URL configuration is managed independently in Vercel. Never expose Worker secrets to the browser.

## Production integration gate

See [the production integration and cutover plan](../architecture/MIGRATION-PLAN.md). Repository CI does not replace deployed Preview verification.
