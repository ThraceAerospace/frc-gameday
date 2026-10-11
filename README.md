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
