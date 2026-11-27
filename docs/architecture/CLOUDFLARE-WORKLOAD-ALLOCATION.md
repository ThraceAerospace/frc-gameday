# Cloudflare workload allocation

**Status:** Target architecture  
**Deployment:** Production cutover follows the integration gate in [MIGRATION-PLAN.md](MIGRATION-PLAN.md).

## Deployment boundary

FieldView uses one environment-neutral Cloudflare Worker named `runtime`, configured by `workers/fieldview/wrangler.toml`. Its entrypoint composes Runtime HTTP/WebSocket routes, webhook ingress, Durable Object classes, Cron handling, and Workflow entrypoints. Branch and pull-request validation uses Workers Preview URLs and Preview bindings from the same configuration. Wrangler named environments and split Runtime/Jobs Workers are not used.

## Resource ownership

| Resource | Responsibility | Must not own |
|---|---|---|
| EventRuntime Durable Object | Event provider endpoint records, validators, reconciliation, event-owned canonical facts, read-time EventState projection, event-wide analytics ownership | Provider scheduling, recurring alarms, team-owned canonical state |
| TeamRuntime Durable Object | Team/year provider endpoint records, validators, reconciliation, team-owned canonical facts, read-time TeamState projection, team-event and team analytics ownership | Event-wide provider state or polling schedules |
| Multiplexer Durable Object | Single public `/stream` WebSocket and subscription coordination; forwards transient data-bearing messages | Provider acquisition or canonical snapshot storage |
| RemoteSessionRuntime Durable Object | Pairing-scoped WebRTC signaling over hibernatable WebSockets | Redis presence, heartbeat loops, alarm polling |
| D1 | Discovery directories and operational/system records | Runtime provider endpoint payloads or persisted EventState/TeamState |
| KV | Small, non-authoritative projections and canonical pointers | Authoritative provider data |
| Workflows | Season discovery, first-registration runtime initialization/bootstrap, season ingestion, polling orchestration, analytics, and admin jobs | Recurring provider proxy or long-lived canonical provider storage |
| Worker Static Assets | Runtime admin dashboard | Application data |

There is no R2 bucket/binding, Redis service, Cloudflare Queue refresh path, or Durable Object alarm polling.

## Provider data lifecycle

1. Discovery Workflows resolve the canonical season and acquire event/team directories.
2. First-registration initialization Workflows register new runtime identities and may perform one bounded provider acquisition to hydrate the corresponding EventRuntime or TeamRuntime.
3. Bootstrap imports provider endpoint records and acquisition metadata only. It does not generate or persist EventState or TeamState.
4. Once initialized, the owning runtime performs all ongoing provider requests in response to explicit refresh commands.
5. The polling coordinator selects due runtime identities, applies lifecycle policy and concurrency budgets, and dispatches commands. It does not fetch provider data.
6. Authenticated webhook reconciliation routes changes to the owning runtime.
7. Reads construct normalized EventState/TeamState from stored endpoint records. A matching in-memory projection may accelerate the read; the projection is disposable and reads perform no storage writes or provider requests.

## Scheduling and backpressure

Worker Cron triggers start coordinator Workflows. The coordinator selects eligible targets, applies bounded concurrency and provider request spacing, and dispatches explicit refresh commands. Runtime-local refresh logic owns provider requests, validators, reconciliation, persistence, and publication. Direct bounded dispatch is the default; no Queue or Durable Object alarm is retained as a fallback.

## Realtime and webhook paths

- Browser: canonical HTTP snapshot first, then the single Worker `/stream` connection through SharedWorker.
- Runtime publication: changed EventState snapshot or team-event patch/data plus identity/revision metadata; analytics sends its committed publication.
- Client: applies ordered data-bearing updates in memory; no notification, gap, or reconnect triggers an HTTP refetch.
- TBA: signed webhook payloads enter directly at `POST /webhooks/tba`.
- Remote display: uses RemoteSessionRuntime for WebRTC signaling.

There is no Vercel WebSocket route, Redis Pub/Sub, Vercel webhook relay, or web-side provider acquisition.

## Operational constraints

- Keep snapshot and analytics-input GET paths free of Durable Object writes.
- Do not add alarm polling or runtime self-polling.
- Keep provider request concurrency and request spacing bounded.
- Monitor Durable Object writes, D1/KV operations, Workflow duration/retries, and provider freshness.
- Do not add paid resources or a payment-method-dependent resource without explicit approval.
