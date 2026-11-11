# FieldView / FRC Gameday

FieldView is a Next.js application for presenting live FIRST Robotics Competition event data alongside event webcasts.

## Architecture

```
TBA REST / webhooks
        ↓
      Redis
        ↓
  Redis Pub/Sub
        ↓
     WebSocket
        ↓
    EventState
        ↓
       Views
        ↓
     Surfaces

Polling is fallback reconciliation owned by EventState for missed or incomplete updates.
```

The Blue Alliance is the authoritative data source. Redis is the server-side cache, TBA webhooks mutate existing Redis cache entries and then publish event-scoped invalidations through Redis Pub/Sub to WebSocket clients.

WebSocket messages are intentionally small invalidation signals. EventState immediately refetches the webhook-mutated Redis cache. Those webhook-mutated match entries defer their next TBA refresh for 65 seconds, giving upstream TBA time to catch up before ETag/304 validation. Polling remains the reconciliation path for missed or incomplete updates.

## Repository structure

```
src/
├── app/
│   ├── page.tsx
│   ├── gameday/
│   ├── divisional-event/
│   └── api/
│       ├── event/[event]/
│       ├── events/active/
│       ├── district/
│       ├── team/[team]/
│       ├── tba/webhook/
│       └── ws/
├── components/
│   ├── event/
│   ├── eventview/
│   ├── match/
│   ├── multiview/
│   └── team/
└── lib/
    ├── cache/
    ├── gameday/
    ├── multiview/
    ├── realtime/
    └── tba/
```

The current component organization reflects the post-refactor architecture. Do not reintroduce the removed monolithic Gameday components.

## UI invariants

### Tracked-team color

**Tracked teams must always use the application's shared amber color to communicate tracked status.** This is a hard visual invariant, not a component-specific styling preference.

- Use the same amber color currently used by `TileView` / `TileSurface` for tracked-team indicators.
- The indicator may vary by context (for example, an amber outline, ring, border, or highlight), but the color must remain the same.
- Do not use another color to indicate that a team is tracked, even if the component's ordinary team/alliance colors differ.
- If the tracked-team amber is ever changed, update every tracked-team indicator across the application together. Centralize the color token/helper where practical rather than duplicating amber values in individual components.
- Keep tracked status visually distinct from alliance identity: red and blue continue to identify match alliances; amber identifies tracked teams.

## Reusable event data panels

`src/components/eventdata/EventDataPanel.tsx` is a reusable event-scoped performance panel. It consumes `useEventState`, not its own network/cache path, and currently presents The Blue Alliance OPR, DPR, and CCWM values when available. The same component can be rendered inside TileView or independently at `/event/<event>/data`. OPR values are fetched through `/api/event/<event>/oprs` and share the event-state lifecycle; Statbotics is not required.

Tile surfaces support both EventView tiles (`event=<eventKey>`) and data-panel tiles (`panel=<eventKey>`). Their stable tile IDs are separate from event keys, so an event can appear as both a live EventView and a performance panel at once.

## EventView and EventState

`EventView` presents event information, webcast selection, tracked-team context, and footer content. It consumes the shared per-event `EventState`; it does not own a separate event-data acquisition lifecycle.

`EventState` owns the current event snapshot and its TBA/Statbotics acquisition and synchronization lifecycle, including WebSocket update handling, freshness, reconciliation, and fallback refreshes. Multiple Views and Surfaces for the same event consume the same EventState rather than creating duplicate fetch or polling paths.

Specialized presentation/derivation hooks remain separate where applicable:

- `useTrackedMatches` — tracked-team match derivation.
- `useStreamController` — webcast normalization and selection.


## Event Insights

The standalone `/insights/event/<event>` analytics workspace participates in the shared live runtime. It consumes `useEventState` snapshots through the origin-wide SharedWorker/WebSocket system, just like Tile View, and refreshes its server-calculated analytics when the current completed match changes. It must not create a separate WebSocket or move authoritative analytics calculations into the browser. Historical Statbotics collection is a resumable Redis-backed server job: the API returns the complete-so-far snapshot and uses Vercel `waitUntil` to process bounded match batches with retries and concurrency limits. The page automatically refreshes collection progress/results; it does not require manual pagination. The worker periodically refreshes the TBA event match schedule and OPR, while WebSocket/EventState changes trigger immediate refresh of the latest completed match.

## Analytics architecture

The event analytics workspace has distinct scopes: **Event Overview**, **Team Investigation** (one selected team at a time: strength, expectations, development, peer-relative performance, and season anomaly history), **Qualification Analysis** (event-wide qualification match review), **Playoff Analysis** (elimination match review), **Playoff Alliances** (three-team composition and elimination progression), and **Suggested Review** (evidence-backed scouting leads). These scopes share server-calculated event data; team season match history is fetched only for the selected team. See [ANALYTICS-REDESIGN.md](ANALYTICS-REDESIGN.md) for metric definitions, baselines, and limitations.

TBA and Statbotics acquisition, normalization, statistical calculations, and analytical conclusions remain server-side. The browser selects views and presents the resulting data; it does not call upstream providers or implement a parallel statistical model. Official qualification rank and Statbotics EPA are displayed side by side as distinct measures, not treated as interchangeable scores.

FRC team branding colors are acquired through the cached provider in `src/lib/frc-colors/`. Event analytics requests the FRC Colors event endpoint once per event collection/refresh, caches the response in Redis for 24 hours, and passes primary colors through the persisted analytics snapshot. The qualification match schedule uses those colors only for each robot's EPA-bar segment; missing or colliding colors use distinct fallbacks. The provider is not called by the browser or once per match.

Statbotics uses the official public API (`https://api.statbotics.io`) by default. `STATBOTICS_API_BASE_URL` remains an explicit override for a compatible self-hosted instance. All Statbotics requests go through the low-level client in `src/lib/statbotics/client.ts` and the application-facing service in `src/lib/statbotics/service.ts`; consumers must not call the upstream API directly. The client honors upstream `Cache-Control: max-age` when present, with a conservative 10-minute minimum between requests for the same resource. When max-age is absent, match and team-year records use a 10-minute fallback and team-event records use a 24-hour fallback. Failed refreshes preserve stale data and are backed off. Event-level analytics workers limit Statbotics match collection to two concurrent upstream requests.

Analytics services are independent of Next.js route handlers and Vercel execution details. Vercel serverless functions currently invoke the services, with Redis holding resumable job state and Vercel `waitUntil` acting only as a bounded execution adapter. The same service functions should remain callable by a future dedicated worker without changing the client-facing API.

Long-running work is bounded and resumable; Redis is authoritative for job progress, retry state, and cached snapshots. Prefer incremental updates when match data changes, while periodically reconciling the event schedule, rankings, roster, and OPR. Keep source-data freshness distinct from calculation freshness and record a calculation version when derived snapshots are persisted.

Alliance residuals and combined alliance estimates are contextual evidence, not individual robot attribution. Model provenance, sample coverage, and uncertainty must remain visible wherever analytical conclusions are presented.

Per-team event briefs lead with concise bullet summaries, followed by supporting metrics, graphs, match pointers, and review flags. Flags are correlation-based investigation prompts only. FieldView must not infer or state robot-level causation from alliance scores, model residuals, shared EPA updates, partner combinations, or win-probability outcomes; the human scout investigates causes.

## Match data

The client-side match helpers live in `src/lib/gameday/matchUtils.ts`.

The presentation chain is:

```
useMatches → EventView → EventFooter → MatchStrip → MatchCard
```

Next-match selection is based on TBA match state and the canonical match ordering. Do not replace the client-side semantics with `actual_time` or `score_breakdown` alone.

Match cards can also represent playoff alliance information, including Double Elimination events.

## Event footer

Each EventView has an independent footer mode:

- `Hidden`
- `Matches`
- `Rankings`
- `Matches + Rankings`

The event identity tab remains visible when the match/rankings bar is hidden. Multiview layouts can temporarily hide the footer bar without changing the EventView's configured footer mode.

The event identity tab also reports WebSocket state:

- green — connected and receiving WebSocket updates;
- blue — connected, but fallback polling has fired;
- gray — disconnected.

## Multiview

Multiview separates five concepts:

1. content/data;
2. stable stream identity;
3. priority;
4. layout;
5. highlight.

The streams array is the stable set of EventView instances. Priority determines which existing streams occupy layout slots; changing priority must not reorder or remount the streams.

Layout definitions live in `src/lib/multiview/layouts.ts`.

Current keyboard controls:

- `1–9` — highlight a stream;
- `0` — clear highlight;
- `Ctrl+1–9` — select a stream for priority editing;
- `Arrow Up/Down` — move the selected priority item;
- `-` / `=` — cycle the explicit layout.

## TBA client and cache

The low-level TBA client lives under `src/lib/tba/`.

Rules:

- Redis is the application cache.
- TBA ETag and Cache-Control max-age determine freshness.
- Never hardcode a TBA max-age.
- The full event match cache remains the canonical Gameday cache.
- TBA Cache-Control max-age controls cache freshness.
- A 304 response refreshes Redis expiry using TBA's supplied cache lifetime.
- Webhooks mutate existing Redis match data directly when the payload contains the changed match information.
- EventView refetches the webhook-mutated Redis cache immediately.
- The client debounces the direct TBA refetch associated with the WSS broadcast for 65 seconds; Redis TTLs are never modified by webhook handling.
- Do not add another cache layer for webhook support.

The application-facing service is `src/lib/tba/service.ts`.

## TBA webhooks and WebSockets

The TBA webhook flow is:

```
authenticate
    ↓
parse payload
    ↓
mutate existing Redis cache
    ↓
broadcast event-scoped WSS invalidation
    ↓
client immediately refetches Redis-mutated data
    ↓
client-side broadcast refetch after 65 seconds
    ↓
polling reconciliation restarts
```

Webhook authentication uses `X-TBA-HMAC` and `TBA_WEBHOOK_TOKEN`.

The WebSocket endpoint is `/api/ws?event=<eventKey>`. Redis Pub/Sub feeds the local WebSocket bridge through the `gameday:tba` channel.

Polling is reconciliation, not the primary realtime transport.

## Polling

Current fallback intervals:

| Tier | Interval |
| --- | ---: |
| realtime | 1 second |
| fast | 5 seconds |
| intermediate | 5 minutes |
| long | 15 minutes |

`usePolling` uses a generation counter so an older async reload cannot schedule a new polling window after a newer reload has taken over.

## Event timezone

Event active-state calculations use each event's own TBA timezone rather than the browser timezone. This keeps active/upcoming event results consistent across users.

## TBA types

`src/lib/tba/generated.ts` is generated directly from the current TBA OpenAPI schema and must never be hand-edited.

```bash
npm run generate:tba-types
```

`src/lib/tba/types.ts` contains only application-facing aliases and small composed types used by FieldView. It is intentionally much smaller than the generated schema.

The generated schema may contain endpoints or schemas that FieldView does not currently use. That is expected; removing an unused generated schema belongs in the OpenAPI generation process, not in the generated file.

See [README-TBA-TYPES.md](README-TBA-TYPES.md) for the type-generation workflow.

## Statbotics types

`src/lib/statbotics/generated.ts` is generated from the live official Statbotics OpenAPI document. Run `npm run generate:statbotics-types` to refresh it; `predev` and `prebuild` do this automatically. The generator applies fallback response schemas only where upstream definitions are missing or generic, and automatically defers to concrete upstream schemas when Statbotics publishes them. See [README-STATBOTICS-TYPES.md](README-STATBOTICS-TYPES.md).

## Development

```bash
npm install
npm run dev
npm run lint
npm run build
```

TBA types are regenerated automatically by `predev` and `prebuild`.

Do not commit secrets. The TBA webhook requires `TBA_WEBHOOK_TOKEN`; stream URL construction may use `NEXT_PUBLIC_DOMAIN`.


## Match Insights and multi-display sessions

FieldView follows one-session/one-state ownership: **one session → one set of event states → many displays**. Configure the event list, tracked teams, and streams once; connected displays consume the same session configuration and event snapshots. Presentation mode can vary by display, but a display must not have its own event selection.

The integrated Match Insights display follows the Tile View's valid highlighted tile, falling back to the first tile in priority order. Tile IDs are resolved to event keys through `tileEvents`. The standalone local route `/event/<event>/insights` uses the URL event when no Tile View surface is present.

Architecture boundaries:

- `EventInsightsSurface` hosts the Insights experience for one supplied event key and subscribes to shared `EventState`.
- `EventInsightView` renders the match insight presentation; it does not fetch event or Statbotics data.
- `EventState` owns TBA and Statbotics match acquisition and refresh behavior. Remote displays receive these snapshots from the controller and do not start duplicate acquisition.
- Statbotics fields are accessed directly from the typed API response. The underlying data is not modified; displayed metrics are formatted to at most one decimal place for readability.
- The Insights alliance row sums each team’s OPR, DPR, CCWM, EPA, Auto EPA, Teleop EPA, and Endgame EPA. A total is shown only when all three team values for that metric are available.
- When TBA has posted match scores and a score breakdown, the official, year-specific breakdown is shown below the alliance tables. The year comes from Statbotics match data when available, falling back to the year prefix in the TBA match key.


## Event Analytics prototype

The standalone event analytics workspace lives at `/insights/event/<event>` and is intentionally separate from Gameday tile surfaces. It consumes the same server-side TBA and Statbotics services, then derives team strength and peer comparisons, alliance score residuals, qualification anomalies, playoff alliance performance, rating progression, and scouting review flags. Alliance-level residuals and shared model updates are not attributed to individual robots.

The event analytics API is `/api/insights/event/<event>`. It returns the current complete-so-far snapshot while a resumable Redis-backed worker collects the event match sample with bounded Statbotics concurrency; the browser polls collection status/results and does not request manual pages. Team Investigation separately loads the selected team's official-season match history and Statbotics match records. Event-roster team-event snapshots support the current event team briefs. Derived data is cached in Redis; the analytics layer does not create a permanent historical match database.

This is an exploratory prototype. Findings and review status are not persisted; review actions are local to the browser. Match residuals and rating updates are alliance/model-level signals and must not be interpreted as robot-specific attribution. Event-relative percentiles are only comparable within the loaded event roster.


## Homepage event snapshot

The homepage is a server-rendered snapshot of the current Sunday–Saturday calendar week and is revalidated hourly. Each event card includes its type, location, competition status, webcast availability, and the last/next match when available.

Match summaries are derived on the server from the canonical full event match schedule using the shared `sortMatches`, `getLastMatch`, and `getNextMatch` helpers. Schedule reads reuse the existing TBA Redis cache, including its TBA-controlled freshness, ETag handling, and webhook mutations. The homepage does not create a separate summary cache, browser polling loop, or WebSocket subscription.


## Homepage event snapshot

The homepage is a server-rendered snapshot of the current Sunday–Saturday calendar week and is revalidated hourly. Each event card includes its type, location, competition status, webcast availability, and the last/next match when available.

Match summaries are derived on the server from the canonical full event match schedule using the shared `sortMatches`, `getLastMatch`, and `getNextMatch` helpers. Schedule reads reuse the existing TBA Redis cache, including its TBA-controlled freshness, ETag handling, and webhook mutations. The homepage snapshot itself is cached for one hour; the page does not create a separate match cache, browser polling loop, or WebSocket subscription.


## Elimination performance shift analysis

The season-long team match analysis calculates a qualification-to-elimination score-residual shift separately for each official event. Only events with at least three scored qualification matches and two scored elimination matches with usable pre-match Statbotics predictions are eligible. Each event contributes one shift to the season summary so events with larger playoff schedules do not dominate. The summary reports mean/median event shift, negative-shift event count, and a one-sided exact sign test across event-level shifts. A recurring-negative label requires at least three eligible events, at least three negative shifts, and sign-test p ≤ 0.05. This is an exploratory association in alliance-level residuals, not proof of robot-level underperformance or choking. The first-pass calculation is not yet adjusted for partner/opponent strength; the UI states this limitation explicitly. Match keys for the qualification and elimination evidence are retained for direct match review.


## Season-wide cohort analytics

Event Insights builds a Redis-backed, resumable season cohort for every team on the target event roster. For each team, it discovers all official-season events (excluding TBA event types 99 offseason and 100 preseason), then retrieves Statbotics team-event snapshots through the configured Statbotics API endpoint (official API by default). Work is bounded by a 22-second execution budget, two concurrent upstream requests, small batches, per-record retry limits, a finite lock, and a 24-hour job TTL. Team-event snapshots are cached for 24 hours; the current target event is explicitly refreshed on a 10-minute cadence. This avoids fan-out requests from the browser and avoids collecting every season match for every event team.

The team brief compares the target event EPA total-points value with that team's most recent preceding official event, then ranks the change against all event-roster teams with usable prior/current snapshots. Coverage and failed records remain visible. These cross-event differences can include timing, event strength, model updates, and game-context effects; the comparison is descriptive and not a causal or direct robot contribution measure.

The selected-team match-history endpoint adds an event-normalized residual pattern. It compares the selected team's mean alliance score residual with the residual distribution from both alliances in the same matches, requires at least three team matches and six baseline alliance samples per event, and tests whether below- or above-baseline directions recur across events. This is an approximate baseline sampled from matches featuring the team, not an independent event-wide calibration sample. It cannot separate the selected team from its partners or opponents.


### Reader-first analytics presentation

Each analytics view leads with a concise plain-language takeaway, then shows only the evidence needed to support it. Detailed tables, secondary metrics, statistical tests, and model diagnostics remain available in clearly labeled expandable sections. Event Overview summarizes the competitive picture; Team Investigation begins with a single-team brief and season risk history; Qualification Analysis prioritizes unusual prediction outcomes; Playoff Analysis separates elimination alliance performance from qualification analysis; Matchup Analysis begins with the recorded result; Scouting Tools puts actionable review signals ahead of aggregate diagnostics. Conclusions remain descriptive and traceable to their supporting data, never causal robot-level attribution.
