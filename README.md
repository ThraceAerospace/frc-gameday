# FieldView

FieldView is a data application for FIRST Robotics Competition. Its first-class web application makes competition data accessible and understandable through live event views, team/event information, and server-calculated analytics.

The priority is trustworthy data: acquiring it, reconciling it, deriving useful information from it, and presenting it clearly.

## Product surfaces

- **Events and teams** — browse current-season events, teams, and districts.
- **Event pages** — view event information and competition context.
- **Gameday** — compose live event views in the Tile View / Multiview surface, including match schedules, rankings, team tracking, and webcast presentation.
- **Insights** — inspect match predictions, event analytics, team comparisons, and evidence for human scouting review.
- **Remote display** — control a shared viewing session from a controller and present its state on connected displays.

## Current architecture

### Data acquisition

- The Blue Alliance is the authoritative source for official event schedules, match results, teams, rankings, and OPR/DPR/CCWM data.
- TBA requests pass through `src/lib/tba/client.ts` and `src/lib/tba/service.ts`, with Redis-backed response caching, ETag validation, and upstream `Cache-Control` freshness.
- TBA webhooks authenticate through `X-TBA-HMAC`, update existing cached match data where possible, and publish event-scoped updates through Redis Pub/Sub and `/api/ws`.
- Statbotics and FRC Colors are enrichment providers behind server-side clients/services. The current Statbotics runtime host and its mismatch with the project's official-provider requirement are recorded in the [application audit](docs/APPLICATION-AUDIT.md).

### Live event state

The normal browser live path uses one origin-wide SharedWorker to own the event WebSocket and one `EventState` per active event. Tabs receive snapshots through MessagePorts. EventState owns event acquisition, freshness, and reconciliation; presentation components consume its snapshots. If SharedWorker is unavailable, the client uses a per-tab fallback.

Remote displays consume controller-published snapshots and do not create independent event acquisition paths.

### Event Analytics

Event Analytics calculations and orchestration live on the server under `src/lib/insights/`. The current dashboard retrieves an `EventAnalytics` snapshot through `/api/insights/event/<event>`; that HTTP lifecycle is separate from the SharedWorker-owned EventState lifecycle. The versioned EventAnalytics envelope is an initial compatibility contract, not yet a fully provider-independent DTO.

See [EVENT-STATE-AND-ANALYTICS.md](docs/EVENT-STATE-AND-ANALYTICS.md) for the current lifecycle and intended integration sequence.

### Event timezone

All event-related dates and times displayed by FieldView must use the event's IANA timezone. For multi-event views, each event uses its own timezone.

## Development

```bash
npm install
npm run dev
npm run lint
npm run build
```

TBA and Statbotics types are generated from their upstream OpenAPI documents. The `predev` and `prebuild` lifecycle scripts regenerate both type sets automatically. To run either generator directly:

```bash
npm run generate:tba-types
npm run generate:statbotics-types
```

Do not commit secrets. The application uses environment configuration for Redis, TBA authentication/webhook verification, and optional provider/runtime overrides.

There is currently no dedicated test script in `package.json`; lint/build validation and focused automated data-contract tests remain part of stabilization work.

## Documentation

- [Application audit](docs/APPLICATION-AUDIT.md) — verified implementation map, findings, and follow-up priorities.
- [Architecture](docs/ARCHITECTURE.md) — current boundaries and target architecture.
- [EventState and EventAnalytics lifecycle](docs/EVENT-STATE-AND-ANALYTICS.md) — live state, analytics acquisition, contract, and integration plan.
- [Analytics redesign](docs/ANALYTICS-REDESIGN.md) — metric definitions, baselines, and limitations.
- [Color system](docs/COLOR-SYSTEM.md) — brand and semantic color roles.
- [TBA API typing](docs/TBA-TYPES.md) — generated and application-facing TBA types.
- [Statbotics API typing](docs/STATBOTICS-TYPES.md) — generated and application-facing Statbotics types.

Repository agent instructions are in [AGENTS.md](AGENTS.md). `CLAUDE.md` points to the same instructions.
