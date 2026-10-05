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
    EventView
   ┌────┼──────────────┐
matches teams/statuses playoff alliances
        │
     webcast UI

Polling is fallback reconciliation for missed or incomplete updates.
```

The Blue Alliance is the authoritative data source. Redis is the server-side cache, TBA webhooks are the preferred realtime mutation path, Redis Pub/Sub carries invalidation events internally, and event-scoped WebSockets notify browsers.

WebSocket messages are intentionally small invalidation signals. Clients refetch the affected data after receiving them.

## Repository structure

```
src/
├── app/
│   ├── page.tsx
│   ├── gameday/
│   ├── divisional-event/
│   ├── cast/reciever/
│   └── api/
│       ├── event/[event]/
│       ├── events/active/
│       ├── district/
│       ├── team/[team]/
│       ├── tba/webhook/
│       ├── admin/redis/
│       └── ws/
├── components/
│   ├── event/
│   ├── eventview/
│   ├── match/
│   ├── multiview/
│   └── team/
└── lib/
    ├── cast/
    ├── cache/
    ├── gameday/
    ├── multiview/
    ├── realtime/
    └── tba/
```

The current component organization reflects the post-refactor architecture. Do not reintroduce the removed monolithic Gameday components.

## EventView

EventView owns event-level data and presentation:

- event metadata;
- teams and team statuses;
- canonical event matches;
- playoff alliances;
- tracked teams;
- webcast selection;
- WebSocket lifecycle;
- fallback refreshes;
- event footer content.

The specialized hooks remain separate:

- `useEvent` — event data.
- `useMatches` — canonical matches and derived next/last matches.
- `useTeams` — event teams.
- `useTeamsStatuses` — event team statuses.
- `usePlayoffAlliances` — playoff alliances.
- `useTrackedMatches` — tracked-team match derivation.
- `useStreamController` — webcast normalization and selection.
- `useWebSocket` — WSS lifecycle and reconnect.
- `usePolling` — fallback scheduling.

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
- Webhook match mutations operate on the canonical full event match cache.
- A newer Redis value written by a webhook must not be overwritten by an older in-flight TBA response.
- A 304 response refreshes Redis expiry using TBA's supplied cache lifetime.
- Do not add another cache layer for webhook support.

The application-facing service is `src/lib/tba/service.ts`.

## TBA webhooks and WebSockets

The TBA webhook flow is:

```
authenticate
    ↓
parse payload
    ↓
mutate Redis cache when applicable
    ↓
broadcast event-scoped WSS invalidation
    ↓
client refetch
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

## Cast

Cast support is isolated under `src/lib/cast` and `src/app/cast/reciever`. It is separate from the TBA/Redis/WSS data architecture.

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
