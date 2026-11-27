# FieldView architecture

## System boundary

FieldView has a Next.js frontend and one Cloudflare backend. The frontend is hosted on Vercel; the backend is a single environment-neutral Cloudflare Worker named `runtime`. The Worker composes HTTP routes, webhooks, Durable Object classes, polling coordination, and Workflow entrypoints. Branch and pull-request validation uses Cloudflare Workers Preview URLs under the same Worker configuration.

Vercel is a frontend host only. It does not acquire provider data, own canonical persistence, orchestrate backend jobs, receive TBA webhooks, or deliver application realtime updates.

## Runtime ownership

Two Durable Object types own canonical competition data:

- **EventRuntime**, one per event, owns event-scoped TBA/Statbotics endpoint records, event identity/participation/matches/alliances, event-scoped revisions, and event-wide analytics inputs/outputs.
- **TeamRuntime**, one per team, owns team/year-scoped provider endpoint records, team identity and season history, team-event state, and team-scoped analytics inputs/outputs.

A runtime is the owner of its scope, not a generic cache. It owns ongoing provider requests, validators, freshness, reconciliation, persistence, retries, and publications. Cross-runtime relationships use stable owner references; one runtime does not persist another runtime's complete canonical records.

Multiplexer owns the single public `/stream` WebSocket and subscription coordination. RemoteSessionRuntime owns remote-display session signaling. D1 repositories own discovery and operational/system records. KV is limited to small, non-authoritative projections and canonical pointers.

## Provider data and state projections

Provider packages acquire and return upstream payloads. The runtime stores provider endpoint responses with validators, acquisition status, freshness, and revisions. Those records are the durable inputs to FieldView.

EventState and TeamState are normalized client-facing read models, not durable canonical records. The owning runtime derives a projection when a client requests a snapshot. A disposable in-memory cache may be used when its source revision/signature matches. A cold read or cache eviction recomputes the projection and performs no Durable Object storage write.

A one-time initialization Workflow may acquire the initial endpoint resources when a runtime is first registered/created. This exception exists to reliably hydrate a new runtime. It stores provider endpoint records in the owning runtime; it does not materialize EventState/TeamState. After bootstrap, all ongoing provider acquisition belongs to EventRuntime or TeamRuntime and is initiated through explicit refresh commands.

## Orchestration and scheduling

Cloudflare Workflows own durable multi-step orchestration, including discovery, season ingestion, first-time runtime registration/bootstrap, analytics, and administrative jobs.

The Worker-level polling coordinator selects eligible runtime identities, applies lifecycle cadence, prioritization, concurrency, overlap prevention, and aggregate request budgets, then dispatches bounded refresh commands. The coordinator does not fetch provider data or construct provider payloads. Each runtime performs its own subsequent provider acquisition and reconciliation.

Durable Object alarms are not used for polling. Cloudflare Queues are not part of the refresh path. Do not introduce Redis, R2, or alternate compatibility infrastructure.

## Read and realtime lifecycle

1. The browser obtains the canonical HTTP event/team snapshot.
2. The browser SharedWorker opens or reuses the Multiplexer-owned `/stream` WebSocket and registers subscriptions.
3. A runtime publishes a data-bearing snapshot or patch notification through Multiplexer. The message includes the actual changed data and sufficient identity/revision metadata for ordered application.
4. The SharedWorker applies the update to its in-memory cache and notifies subscribers.
5. A reconnect restores subscriptions; it does not refetch snapshots or analytics. A notification is never merely an instruction to issue an HTTP GET.

A new page/client read or an explicit user refresh may perform an HTTP read. Reads are side-effect-free: they do not acquire providers, register runtimes, schedule work, or write Durable Object storage.

## Storage domains

| Store | Owner and contents |
|---|---|
| Durable Object SQLite | Canonical provider endpoint records and runtime-scoped state owned by EventRuntime/TeamRuntime; Multiplexer and RemoteSession coordination state |
| D1 | Discovery catalog, runtime registration/system records, Workflow and operational records through typed repositories |
| KV | Small disposable projections and canonical pointers; never authoritative provider records |
| Browser SharedWorker memory | Ephemeral normalized snapshot cache and realtime subscription state |

R2, Redis/ioredis, Queue producer/consumer paths, IndexedDB normalized snapshot persistence, and Durable Object alarm polling are not part of the target architecture.

## Domain boundaries

- `packages/providers/*` owns upstream schemas, transport, credentials, provider-specific retry/rate-limit behavior, and unchanged provider payloads.
- `packages/domain` owns canonical FieldView entities, normalized client-facing contracts, normalization, cross-provider correlation, and source precedence. It is the only provider-independent domain data contract consumed by the frontend.
- `packages/analytics` owns reusable analytics calculations independent of UI and runtime transport.
- `apps/web` consumes FieldView domain contracts and must not fetch provider APIs directly.

## Governing decisions

ADR-0020 is authoritative for provider endpoint storage, read-time projections, and snapshot-first/data-bearing realtime. ADR-0019 defines the single Worker and branch Preview deployment topology. Earlier decisions remain historical only where explicitly superseded by later ADRs.
