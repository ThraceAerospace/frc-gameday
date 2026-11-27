# FieldView

FieldView is a data application for FIRST Robotics Competition. It acquires competition data from provider APIs, stores the provider resources, derives normalized FieldView state on demand, and serves that state to web and live clients.

## Final architecture

- **Frontend:** Next.js 16 / React 19 in `apps/web`, hosted on Vercel. Vercel is a frontend host only; it does not own provider acquisition, event state, analytics orchestration, webhook processing, or realtime delivery.
- **Runtime:** one environment-neutral Cloudflare Worker named `runtime`, composed from `workers/fieldview/src/index.ts` and configured by `workers/fieldview/wrangler.toml`. Branch and PR testing uses Cloudflare Worker Preview URLs and isolated Preview bindings, not Wrangler named environments.
- **Canonical resources:** EventRuntime and TeamRuntime Durable Objects persist provider endpoint responses and their validators/metadata. These provider records are the durable source of truth.
- **Read projections:** EventState and TeamState are normalized client contracts. A read builds the appropriate projection from the stored endpoint records. A DO may reuse an in-memory hot projection, but a cold read regenerates it. A read must not write Durable Object storage. A persisted projection is never required to exist.
- **Acquisition and scheduling:** Cloudflare Workflows and the Worker-level polling coordinator perform discovery, bootstrap, provider refresh, and analytics orchestration. There is no queue-based compatibility path and no Durable Object alarm polling.
- **Storage:** Durable Object SQLite owns event/team provider resources and runtime-scoped data; D1 owns discovery and operational/system records; KV is limited to lightweight projections and canonical pointers. The architecture does not use R2.
- **Realtime:** the browser SharedWorker multiplexes canonical subscriptions to the Worker `/stream` endpoint. It does not fetch provider APIs or run a second EventState polling implementation. Snapshot recovery uses the Worker snapshot endpoints.
- **Webhooks:** TBA posts directly to the Worker's `/webhooks/tba` endpoint. There is no Vercel relay or Redis Pub/Sub fan-out.
- **Remote display:** RemoteSessionRuntime owns WebRTC signaling over hibernatable Durable Object WebSockets; it does not use Redis leases, Vercel WebSockets, heartbeats, or alarm polling.

## Development

Install dependencies with `npm ci`.

Run the frontend and Worker separately:

```bash
npm run dev
npm run dev:worker
```

Local Worker secrets and variables belong in `workers/fieldview/.dev.vars` (copy `workers/fieldview/.dev.vars.example` there). Frontend deployment variables belong to the Vercel project configuration; do not place Worker secrets in frontend-visible variables. Do not create a root `.env` file.

Validate the repository:

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

TBA and Statbotics generated types are maintained by the provider packages. The root scripts regenerate them through `predev` and `prebuild`.

## Integration status

The `fieldview-architecture-migration` branch is the target architecture and the integration-testing candidate. The branch has not been deployed to Cloudflare, merged into `main`, or used for production data. No legacy queue messages, deployed resources, or production data are migration requirements. Final integration testing must validate clean resource creation, provider bootstrap, read-time projection, zero-write reads, polling, analytics, realtime subscriptions, webhook authentication, and remote-session signaling before merge and production deployment.

## Architecture references

- [Architecture overview](docs/ARCHITECTURE.md)
- [Final integration plan](docs/architecture/MIGRATION-PLAN.md)
- [Target resource inventory](docs/architecture/MIGRATION-INVENTORY.md)
- [Retirement audit](docs/architecture/RETIREMENT-AUDIT.md)
- [Architecture decisions](docs/architecture/decisions/)
