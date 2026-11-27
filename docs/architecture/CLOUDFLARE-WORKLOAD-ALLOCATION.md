# Cloudflare Workload Allocation

**Status:** Current target architecture  
**Deployment:** Not yet deployed; Preview integration testing is pending.

## Deployment boundary

FieldView uses one environment-neutral Cloudflare Worker named `runtime`, configured only by `workers/fieldview/wrangler.toml`. The entrypoint composes Runtime HTTP/WebSocket routes and Workflow entrypoints. There are no split Runtime/Jobs Workers and no Wrangler named environments. Cloudflare Worker Preview URLs use isolated Preview bindings from the same configuration.

## Resource ownership

| Resource | Responsibility | Must not own |
|---|---|---|
| EventRuntime Durable Object | Event provider endpoint records, validators, reconciliation, ephemeral EventState projection, event snapshot/analytics publication | Provider scheduling, recurring alarms, team-owned state |
| TeamRuntime Durable Object | Team-season provider endpoint records, validators, TeamState projection, team-event analytics inputs/results | Event-wide provider state or polling schedules |
| Multiplexer Durable Object | Canonical event snapshot and analytics subscription coordination | Provider acquisition or canonical data storage |
| RemoteSessionRuntime Durable Object | Pairing-scoped WebRTC signaling over hibernatable WebSockets | Redis presence, heartbeat loops, alarm polling |
| D1 | Discovery directories and operational/system records | Provider endpoint payloads or materialized event/team snapshots |
| KV | Small, non-authoritative projections and canonical pointers | Authoritative provider data |
| Workflows | Season discovery, event/team readiness and bootstrap, polling coordination, analytics, coverage, and admin jobs | Long-lived canonical provider storage |
| Worker Static Assets | Runtime admin dashboard | Application data |

No R2 bucket or binding is part of the target. No Cloudflare Queue producer or consumer is part of the target. There are no Durable Object alarm handlers or alarm-driven polling loops.

## Provider data lifecycle

1. Discovery Workflows resolve the canonical season and acquire event/team directories.
2. Readiness Workflows register discovered runtime identities and inspect endpoint-resource readiness.
3. Missing endpoint resources are acquired through provider adapters and imported into EventRuntime or TeamRuntime.
4. The polling coordinator schedules subsequent refreshes according to event/team lifecycle and provider intervals.
5. Explicit webhook reconciliation updates affected endpoint records and publishes scoped changes.
6. Reads construct normalized EventState/TeamState from the stored endpoint records. A matching in-memory or optional persisted projection may accelerate the read; it is never required.
7. A cold read or cache miss rebuilds the projection without writing Durable Object storage or triggering provider requests.

## Scheduling and backpressure

The Worker cron handler starts Workflows. The polling coordinator selects due resources, applies bounded concurrency and provider request spacing, and dispatches explicit refresh commands. Workflow retries own durable retry behavior. Direct bounded dispatch is the current model; no queue is retained as a migration fallback.

## Realtime and webhook paths

- Browser: initial canonical snapshot request, then Worker `/stream`; the browser SharedWorker multiplexes tabs.
- EventRuntime: publishes versioned snapshot and analytics changes through Multiplexer.
- TBA: posts signed webhook payloads directly to `POST /webhooks/tba`.
- Remote display: uses RemoteSessionRuntime `/remote/ws` for WebRTC signaling.

There is no Vercel WebSocket route, Redis Pub/Sub, Vercel webhook relay, or web-side provider acquisition.

## Cost and operational constraints

- Avoid read-triggered DO writes. Snapshot and analytics-input GET paths are storage-read-only.
- Do not add DO alarms or self-polling.
- Keep provider request concurrency and request spacing bounded.
- Monitor DO row writes, D1 operations, KV operations, Workflow duration/retries, and provider freshness.
- Do not add paid resources or a payment-method-dependent resource without explicit approval.
