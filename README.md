# FieldView / FRC Gameday

FieldView is a Next.js application for presenting live FIRST Robotics Competition event data alongside event webcasts.

The current architecture uses The Blue Alliance (TBA) as the authoritative data source, Redis as the server-side cache, TBA webhooks as the preferred realtime update path, Redis Pub/Sub as the internal notification bus, and WebSockets as the browser notification transport.

## Architecture

~~~
TBA REST API ───────────────┐
                           │
TBA webhooks → Redis cache ├→ API responses → GamedayWidget
                  │        │
                  └→ Redis Pub/Sub → WebSocket → browser
                                               │
                                               ├→ matches
                                               ├→ teams/statuses
                                               ├→ playoff alliances
                                               └→ webcast UI

Polling is fallback reconciliation for missed or incomplete webhook updates.
~~~

Important boundaries:

- Redis is the server-side cache.
- TBA webhook handlers mutate the existing Redis cache before broadcasting.
- WebSocket messages are invalidation signals, not copies of the data.
- Clients refetch after WSS notifications.
- Polling reconciles missed webhooks.
- GamedayWidget owns event-level data/UI orchestration.
- Multiview owns stream slots, priority, highlighting, and visual layout.
- Content/data state, stream identity, priority, layout, and highlight are separate concepts.
- Event active-state dates are interpreted in the event's own timezone, not the user's browser timezone.

## Repository structure

~~~
.
├── AGENTS.md
├── CLAUDE.md
├── README.md
├── README-TBA-TYPES.md
├── eslint.config.mjs
├── next.config.ts
├── package.json
├── package-lock.json
├── postcss.config.mjs
├── tsconfig.json
├── public/
│   ├── file.svg
│   ├── globe.svg
│   ├── next.svg
│   ├── vercel.svg
│   └── window.svg
├── scripts/
│   └── generate-tba-types.mjs
└── src/
    ├── app/
    │   ├── page.tsx
    │   ├── layout.tsx
    │   ├── globals.css
    │   ├── ads.txt
    │   ├── favicon.ico
    │   ├── gameday/
    │   │   ├── page.jsx
    │   │   └── divisional-event/[parentEvent]/page.jsx
    │   ├── cast/reciever/page.tsx
    │   ├── testing/nexus/page.tsx
    │   └── api/
    │       ├── admin/redis/
    │       │   ├── route.ts
    │       │   └── delete/route.ts
    │       ├── district/
    │       │   ├── route.ts
    │       │   ├── all/cmp/route.ts
    │       │   └── [district]/advancement/
    │       │       ├── route.ts
    │       │       └── cmp/route.ts
    │       ├── event/[event]/
    │       │   ├── route.ts
    │       │   ├── matches/
    │       │   │   ├── route.ts
    │       │   │   ├── next/route.ts
    │       │   │   └── last/route.ts
    │       │   ├── nexus/route.ts
    │       │   ├── playoffs/alliances/route.ts
    │       │   ├── teams/route.ts
    │       │   ├── teams/statuses/route.ts
    │       │   └── webcasts/route.ts
    │       ├── events/active/route.ts
    │       ├── nexus/webhook/route.ts
    │       ├── tba/webhook/route.ts
    │       ├── team/[team]/
    │       │   ├── route.ts
    │       │   └── district/route.ts
    │       └── ws/route.ts
    ├── components/
    │   ├── gameday/
    │   │   ├── GamedayWidget.jsx
    │   │   ├── ChatView.jsx
    │   │   ├── EventStatsSideBar.jsx
    │   │   ├── StreamModal.jsx
    │   │   ├── StreamView.jsx
    │   │   ├── hooks/
    │   │   │   ├── useEvent.ts
    │   │   │   ├── useMatches.ts
    │   │   │   ├── useNexus.ts
    │   │   │   ├── usePlayoffAlliances.ts
    │   │   │   ├── usePolling.ts
    │   │   │   ├── useStreamController.ts
    │   │   │   ├── useTeams.ts
    │   │   │   ├── useTeamsStatuses.ts
    │   │   │   ├── useTrackedMatches.ts
    │   │   │   └── useWebSocket.ts
    │   │   ├── navbar/
    │   │   │   ├── EventLocalTime.jsx
    │   │   │   ├── MatchCard.tsx
    │   │   │   ├── MatchStrip.jsx
    │   │   │   └── NextMatchCountdown.tsx
    │   │   └── teamElements/
    │   │       ├── Rank.jsx
    │   │       ├── Record.jsx
    │   │       ├── TeamModal.jsx
    │   │       └── TeamPill.jsx
    │   └── multiview/
    │       ├── MultiviewClient.jsx
    │       └── hooks/useMatchImminence.ts
    ├── lib/
    │   ├── cast/
    │   │   ├── castClient.ts
    │   │   ├── types.ts
    │   │   └── useCastSession.ts
    │   ├── gameday/
    │   │   ├── buildStreams.js
    │   │   ├── matchUtils.ts
    │   │   └── normalizeMatches.ts
    │   ├── nexus/types.ts
    │   ├── tba/
    │   │   ├── generated.ts
    │   │   └── types.ts
    │   ├── eventState.ts
    │   ├── layouts.js
    │   ├── redis.ts
    │   ├── tba.ts
    │   ├── tbaClient.ts
    │   ├── tbaFormatters.js
    │   ├── tbaService.ts
    │   ├── time.js
    │   └── websocket.ts
    └── types/cast.d.ts
~~~

## Application pages

- / — FieldView event picker and active-event search.
- /gameday?event=... — Multiview for one or more events.
- /gameday/divisional-event/[parentEvent] — championship/divisional-event Multiview.
- /cast/reciever — Cast receiver.
- /testing/nexus — Nexus development/testing page.

## API

Event routes under /api/event/[event]:

- / — event details.
- /matches — canonical full event match list.
- /matches/next — server-side next-match helper.
- /matches/last — server-side last-match helper.
- /playoffs/alliances — playoff alliances.
- /teams — event teams.
- /teams/statuses — event team statuses.
- /webcasts — event webcast definitions converted to application stream objects.
- /nexus — current Nexus payload from Redis.

Other routes:

- /api/events/active — current/upcoming events.
- /api/team/[team] and /district routes — supporting TBA data.
- /api/tba/webhook — TBA webhook ingestion.
- /api/nexus/webhook — Nexus webhook ingestion.
- /api/ws?event=... — event-scoped WebSocket endpoint.
- /api/admin/redis/* — legacy Redis administration/debugging.

## GamedayWidget

GamedayWidget is the event-level orchestrator.

It owns event data, teams, team statuses, matches, playoff alliances, tracked teams, webcast selection, chat/stat/team UI, WSS handling, refresh behavior, TeamPills, and MatchStrip data.

It does not own Multiview layout or stream priority.

The specialized hooks are deliberately separate:

- useEvent — event data.
- useMatches — canonical full event matches plus derived event next/last matches.
- useTeams — event teams.
- useTeamsStatuses — event team statuses.
- usePlayoffAlliances — playoff alliances.
- useTrackedMatches — tracked-team match derivation.
- useStreamController — webcast stream normalization and selection.
- useWebSocket — WSS lifecycle and reconnect.
- usePolling — shared fallback polling.
- useNexus — retained Nexus/testing path.

## Match data

The client-side canonical helpers live in src/lib/gameday/matchUtils.ts.

The match presentation chain is:

~~~
useMatches → GamedayWidget → MatchStrip → MatchCard
~~~

Next match semantics are intentionally based on TBA scores:

- The next match is the first chronologically sorted match whose alliance score is -1.
- Do not substitute actual_time for this rule.
- Do not substitute score_breakdown for this rule.
- score_breakdown can be null even when scores are available.
- actual_time can also be null.

MatchStrip is the compact official-broadcast-inspired overlay. It keeps relevant matches available, focuses the next match, supports tracked TeamPills, and auto-scrolls while retaining previous-match context.

## Multiview

MultiviewClient owns presentation state:

- stable streams;
- priority;
- explicit layout;
- active/highlighted event;
- highlight layout;
- event picker;
- labels;
- automatic match-imminence focus;
- keyboard controls.

The critical rule is that streams and priority are separate.

The streams array is the stable set of GamedayWidget instances and must not be reordered when priority changes. Priority determines which existing stream occupies each visual slot. Highlighting may temporarily promote a stream to slot zero without permanently changing priority.

This prevents unnecessary React remounts and webcast reloads.

src/lib/layouts.js contains pure layout definitions. Current layouts include Single, Dual, 1+2, Quad, 1+3, 2+3, Hex, 1+5, 1+6, Octo, 2+6, Nona/9-grid, and 1+8.

Presentation metadata currently controls match-information and team-tracker visibility. TeamPills remain horizontal; Multiview controls visibility rather than assigning positional TeamPill modes.

Keyboard controls:

- 1–9 — highlight a stream.
- 0 — clear highlight.
- Ctrl+1–9 — select a stream for priority editing.
- Arrow Up/Down — move the selected priority item.
- - / = — cycle the explicit layout.

## TBA client and cache

src/lib/tbaClient.ts is the low-level TBA REST + Redis cache layer.

Rules:

- Redis is the cache used by the application.
- TBA ETag and Cache-Control max-age determine freshness.
- Never hardcode a max-age observed from a TBA response.
- Webhook match mutations operate on the existing canonical event full-match cache.
- A TBA response must not overwrite a newer Redis value written by a webhook.
- 304 responses refresh Redis expiry using TBA's supplied cache lifetime.
- Do not add a second cache layer for webhook support.

src/lib/tbaService.ts is the application-facing service used by API routes. It covers events, teams, matches, alliances, statuses, districts, advancement, rankings/OPRs, Nexus information, and webcasts.

Some simple/team match methods remain for legacy active-event functionality and should be caller-audited before removal.

## TBA webhooks

The webhook flow is:

~~~
authenticate
    ↓
parse payload
    ↓
mutate existing Redis cache when possible
    ↓
broadcast event-scoped WSS invalidation
    ↓
client refetch
~~~

Authentication uses X-TBA-HMAC and TBA_WEBHOOK_TOKEN:

- Missing HMAC → 418 intentionally.
- Invalid HMAC → 401.
- Authenticated malformed JSON → 400.
- Server/configuration failure → 500.

Current webhook behavior:

- match_score — mutate canonical event match cache.
- match_video — mutate canonical event match cache.
- upcoming_match — merge timing/team information into cached match data.
- alliance_selection — update event cache when possible; clients refetch alliances/statuses/matches.
- schedule_updated — refetch signal.
- starting_comp_level — refetch signal.
- awards_posted — refetch signal for now.
- verification, ping, broadcast — acknowledge without match mutation.
- unknown message types — acknowledge and log.

Redis mutation happens before the WSS broadcast. A broadcast failure does not invalidate a successful cache mutation.

## WebSockets

src/app/api/ws/route.ts upgrades an event-scoped request to WebSocket.

src/lib/websocket.ts bridges Redis Pub/Sub to local WebSocket clients through the gameday:tba channel.

Messages are intentionally small:

~~~
{
  type: "tba-update",
  eventKey: "...",
  messageType: "match_score"
}
~~~

The client uses useWebSocket, reconnecting with exponential backoff up to 30 seconds.

WSS is the preferred realtime path. Polling is reconciliation, not the primary transport.

## Polling

usePolling provides fallback scheduling.

Current intervals:

| Tier | Interval |
| --- | ---: |
| realtime | 1 second |
| fast | 5 seconds |
| intermediate | 5 minutes |
| long | 15 minutes |

The generation counter is intentional. A reload invalidates the previous generation, cancels its timer, performs the current callback, and lets only the newest generation schedule the next fallback.

## Event timezone

/api/events/active parses each event's start/end dates in that event's own TBA timezone.

This means a user in any browser timezone sees the same event active/upcoming state.

Do not replace this with browser-local date comparisons.

## Nexus

Nexus support is retained but is secondary to TBA.

Relevant files:

- src/lib/nexus/types.ts
- src/app/api/nexus/webhook/route.ts
- src/app/api/event/[event]/nexus/route.ts
- src/components/gameday/hooks/useNexus.ts
- src/app/testing/nexus/page.tsx

Nexus payloads are stored under nexus:event:<eventKey> and use dataAsOfTime as the ETag.

Nexus is intentionally not part of the primary Gameday realtime flow right now.

## Cast

Cast support is isolated under src/lib/cast and src/app/cast/reciever. It is separate from the TBA/Redis/WSS architecture.

## TBA types

src/lib/tba/generated.ts is generated from the TBA OpenAPI schema. Never hand-edit it.

~~~
npm run generate:tba-types
~~~

src/lib/tba/types.ts contains application-facing aliases.

See README-TBA-TYPES.md for the type-generation workflow.

## Cleanup and future reorganization

The project went through several architectural iterations, so some historical files and subsystems remain.

Dead-file cleanup is intentionally separate from the eventual directory reorganization.

Before deleting a file:

1. Search the whole repository for references.
2. Distinguish a function/data name from an actual file import.
3. Confirm that a newer replacement is really the implementation in use.
4. Delete only after confirming there are no live callers.

Known historical cleanup includes the duplicate JavaScript useStreamController implementation, the standalone getMatchesForTeams helper, and legacy LastMatch/NextMatch presentation components.

The directory layout will eventually be reorganized around the current architecture, but that is a separate refactor. Do not mix a broad directory move with routine dead-code cleanup unless explicitly requested.

## Development

~~~
npm install
npm run dev
npm run lint
npm run build
~~~

TBA types are regenerated automatically by predev and prebuild.

Do not commit secrets. The TBA webhook requires TBA_WEBHOOK_TOKEN; stream URL construction may use NEXT_PUBLIC_DOMAIN.
