# FieldView

FieldView is a data application for FIRST Robotics Competition. Its first-class web application makes competition data accessible and understandable through live event views, team/event information, and server-calculated analytics.

The priority is trustworthy data: acquiring it, reconciling it, deriving useful information from it, and presenting it clearly.

## Product surfaces

- **Events and teams** — browse current-season events and teams; team/event pages show district membership from their own provider data.
- **Event pages** — view event information and competition context.
- **Gameday** — compose live event views in the Tile View / Multiview surface, including match schedules, rankings, team tracking, and webcast presentation.
- **Insights** — inspect match predictions, event analytics, team comparisons, and evidence for human scouting review.
- **Remote display** — control a shared viewing session from a controller and present its state on connected displays.

## Architecture migration

The `fieldview-architecture-migration` branch is rebuilding FieldView around an npm-workspace monorepo with a retained Next.js frontend and a hybrid Cloudflare Workers/Durable Objects backend. The backend is deployed as one shared Runtime Worker per environment (`runtime-preprod` and `runtime-production`) from the single `workers/fieldview/wrangler.toml` configuration. FieldView is its first product; the generic Runtime name leaves room for future FIRST program support without implying those integrations already exist.

The current implementation described below is the legacy system being migrated. It remains in place until replacement slices have passed validation; no production cutover is implied.

- [Architecture migration plan](docs/architecture/MIGRATION-PLAN.md) — confirmed decisions, target boundaries, phases, exit criteria, and risks.
- [Migration inventory](docs/architecture/MIGRATION-INVENTORY.md) — current routes, dependencies, environment variables, and target ownership mapping.
- [Architecture decisions](docs/architecture/decisions/) — accepted repository/runtime direction, including [analytics ownership (ADR-0011)](docs/architecture/decisions/ADR-0011-ANALYTICS-OWNERSHIP.md).

## Current architecture (legacy implementation)

### Data acquisition

- The Blue Alliance is the authoritative source for official event schedules, match results, teams, rankings, and OPR/DPR/CCWM data.
- TBA requests pass through `src/lib/tba/client.ts` and `src/lib/tba/service.ts`, with Redis-backed response caching, ETag validation, and upstream `Cache-Control` freshness.
- TBA webhooks authenticate through `X-TBA-HMAC`, attempt to update existing cached match data, and publish event-scoped updates through Redis Pub/Sub and `/api/ws`. Cache coherence is not yet complete across standalone/team-scoped matches and dependent status/alliance/OPR resources; see the [application audit](docs/APPLICATION-AUDIT.md).
- Statbotics and FRC Colors are enrichment providers behind server-side clients/services. The current Statbotics runtime host and its mismatch with the project's official-provider requirement are recorded in the [application audit](docs/APPLICATION-AUDIT.md).

### Live event state

The normal browser live path uses one origin-wide SharedWorker to own the event WebSocket and one `EventState` per active event. Tabs receive snapshots through MessagePorts. EventState owns event acquisition and reconciliation; its current snapshot exposes only coarse global loading/error/WebSocket-stale state rather than per-resource freshness/failure metadata. If SharedWorker is unavailable, the client uses a per-tab fallback (whose WebSocket idle teardown remains incomplete; see the audit).

Remote displays consume controller-published snapshots and do not create independent event acquisition paths.

### Event Analytics

Event Analytics calculations and orchestration live on the server under `src/lib/insights/`. The current dashboard retrieves an `EventAnalytics` snapshot through `/api/insights/event/<event>`; that HTTP lifecycle is separate from the SharedWorker-owned EventState lifecycle. The versioned EventAnalytics envelope is an initial compatibility contract, not yet a fully provider-independent DTO.

See [EVENT-STATE-AND-ANALYTICS.md](docs/EVENT-STATE-AND-ANALYTICS.md) for the current lifecycle and intended integration sequence.

### Event timezone

All event-related dates and times displayed by FieldView must use the event's IANA timezone. For multi-event views, each event uses its own timezone.

## Development

Create one ignored environment file at the repository root:

```bash
npm install
touch .env
```

Keep all local web and Worker environment values in that root `.env`. Do not create workspace-specific `.env.local`, `.dev.vars`, or other duplicate secret files. The root `.env` is ignored by Git.

Run the web app and checks:

```bash
npm run dev
npm run lint
npm run build
```

Run the consolidated Cloudflare Worker locally with the same root file:

```bash
npm run dev:worker
```

The `dev:worker` script loads the root `.env`, then starts Wrangler with `workers/fieldview/wrangler.toml` and the explicit `preprod` environment. Cloudflare-hosted Preproduction and Production secrets remain independently configured in Cloudflare and are not synchronized from this local file. The base `runtime` configuration is a shared template; always select a named environment for local execution or deployment.

TBA and Statbotics types are generated from their upstream OpenAPI documents. The `predev` and `prebuild` lifecycle scripts regenerate both type sets automatically. To run either generator directly:

```bash
npm run generate:tba-types
npm run generate:statbotics-types
```

Do not commit secrets. Add only the variables required by the services you run locally (for example, `TBA_API_KEY`, `TBA_WEBHOOK_SECRET`, `RUNTIME_ADMIN_TOKEN`, and any legacy web-service credentials still needed by your local setup).

There is currently no dedicated test script in the legacy root `package.json`; test infrastructure is part of the repository foundation work.

## Documentation

- [Application audit](docs/APPLICATION-AUDIT.md) — verified legacy implementation map, findings, and follow-up priorities.
- [Architecture](docs/ARCHITECTURE.md) — current boundaries and target architecture.
- [EventState and EventAnalytics lifecycle](docs/EVENT-STATE-AND-ANALYTICS.md) — live state, analytics acquisition, contract, and integration plan.
- [Analytics redesign](docs/ANALYTICS-REDESIGN.md) — metric definitions, baselines, and limitations.
- [Color system](docs/COLOR-SYSTEM.md) — brand and semantic color roles.
- [TBA API typing](docs/TBA-TYPES.md) — generated and application-facing TBA types.
- [Statbotics API typing](docs/STATBOTICS-TYPES.md) — generated and application-facing Statbotics types.

Repository agent instructions are in [AGENTS.md](AGENTS.md). `CLAUDE.md` points to the same instructions.
