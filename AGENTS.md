# Agent Instructions

## Project

FieldView / FRC Gameday is a Next.js application for live FIRST Robotics Competition event presentation.

The codebase is in a stabilization and cleanup phase after the Multiview/EventView refactor.

## Branch

Use `main` unless the user explicitly requests another branch.

## Core architecture

The intended realtime flow is:

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
```

Rules:

1. Redis is the server-side cache.
2. TBA webhooks are the preferred realtime invalidation path.
3. TBA webhooks mutate existing Redis cache entries first, then broadcast an event-scoped WSS invalidation.
4. EventState refetches Redis immediately after the webhook mutation. Webhook-mutated match caches keep the new data available to the UI while their TBA refresh deadline is deferred for 65 seconds, allowing upstream TBA to catch up before ETag/304 validation.
5. WSS messages are invalidation signals, not data payloads.
6. Polling reconciles missed webhooks and every explicit reload restarts the polling generation.
7. Do not introduce another cache layer to support webhooks.
8. Do not hardcode TBA Cache-Control max-age values.
9. The full event `/event/<event>/matches` cache is the canonical match cache for Gameday.
10. Do not reintroduce the old simple/team match caches into the primary realtime path.

## TBA webhook authentication

Endpoint: `/api/tba/webhook`.

Authenticate `X-TBA-HMAC` before parsing JSON.

- Missing HMAC → HTTP 418 intentionally.
- Invalid HMAC → HTTP 401.
- Authenticated malformed JSON → HTTP 400.
- Internal/configuration failure → HTTP 500.

Mutate the relevant existing Redis cache after authentication/parsing, then broadcast. A broadcast failure must not undo a successful cache mutation.

## Client realtime behavior

The shared event WebSocket manager connects to `/api/ws?event=<eventKey>` and reconnects with exponential backoff. Each `EventState` handles event-scoped TBA invalidations, refreshes its own resources, and owns its fallback/reconciliation lifecycle. Views consume the resulting snapshots; they must not start duplicate refresh loops. Keep the manual `r` refresh behavior unless explicitly changed.

## Polling

`usePolling` is shared fallback infrastructure.

Current intervals:

- realtime: 1 second
- fast: 5 seconds
- intermediate: 5 minutes
- long: 15 minutes

Its generation counter is intentional. A reload must invalidate older work, cancel the old timer, run the current callback, and allow only the newest generation to schedule the next fallback.

Do not replace this with a naive `setInterval` implementation.

## Match semantics

The client-side canonical match helpers are in `src/lib/gameday/matchUtils.ts`.

The presentation chain is:

```
useMatches → EventView → EventFooter → MatchStrip → MatchCard
```

Preserve the established next-match semantics and the stale-response protection in `useMatches`.

## Multiview

MultiviewView owns:

- stable streams;
- priority;
- layout;
- highlight;
- event picker;
- labels;
- automatic match-imminence focus;
- keyboard controls.

Keep these concepts separate:

1. content/data;
2. stable stream identity;
3. priority;
4. layout;
5. highlight.

The streams array is the stable set of EventView instances. Never reorder streams merely to change priority. Priority determines which existing streams occupy layout slots.

Layouts are pure data in `src/lib/multiview/layouts.ts`.

Do not restore old positional TeamPill modes.

## Reusable event data panels

`src/components/eventdata/EventDataPanel.tsx` is an event-scoped presentation component, not a tile-only implementation. It consumes the shared `useEventState` snapshot and can be rendered from any client component/page. Keep its TBA-backed OPR/DPR/CCWM data in `EventState`; do not introduce a separate client fetch/cache or require Statbotics.

Tile identity is distinct from event identity. `TileSurfaceState.streams` and `priority` contain stable tile IDs; `tileEvents` maps each tile to its event key, and `tileTypes` distinguishes `eventView` from `dataPanel`. Preserve existing `event=<key>` URLs and use `panel=<key>` for data panels. The same event may be represented by both tile types. All displays connected to one session share this single Tile Surface configuration; event, team, and stream configuration is performed once, not per display. Match Insights follows the highlighted valid tile or the first priority tile.

## Match Insights surfaces

- `EventInsightsSurface` is the Surface/container for one event's Insights experience.
- `EventInsightView` is presentation only. It consumes the supplied `EventStateSnapshot`; it must not fetch Statbotics data or create event-data subscriptions.
- `EventState` owns Statbotics match acquisition alongside TBA event data. It keeps the current next/last match data available to all Views, refreshes completed matches after the existing delay, and exposes results in `statboticsMatches`.
- Use `resolveActiveEventKey` for the integrated Insights display: valid highlighted tile first, otherwise the first tile in priority order; resolve tile ID through `tileEvents`.
- The local Tile View can switch to Insights using the same active-event rule. The standalone `/event/<event>/insights` route supplies its event key directly and uses the same `EventState` lifecycle.
- Display Statbotics numeric values directly from the API response. Do not add application-side rounding, truncation, or derived alliance totals.

## Event footer

EventView footer configuration is independent from Multiview layout presentation.

Valid footer modes are:

- `matchStrip`
- `rankings`
- `split`
- `statbotics` — shows the regular match strip beside Statbotics prediction metrics.
- `hidden`

Multiview may temporarily hide the footer bar through `footerHidden`, but it must not select or override the EventView's configured footer content mode.

## Gameday hooks

Keep responsibilities specialized:

- `useEvent` — event.
- `useMatches` — canonical full matches and event next/last.
- `useTeams` — teams.
- `useTeamsStatuses` — statuses.
- `usePlayoffAlliances` — playoff alliances.
- `useTrackedMatches` — tracked-team derivation.
- `useStreamController` — stream normalization/selection.
- `useWebSocket` — WSS lifecycle.
- `usePolling` — fallback scheduling.

Do not reintroduce Nexus unless explicitly requested.

Avoid rebuilding a monolithic `useGameday` hook.

## Event timezone

`/api/events/active` interprets event dates using the event's own timezone. Do not replace this with browser-local comparisons.

## TBA client

The low-level TBA client is under `src/lib/tba/`.

Preserve:

- Redis-backed caching;
- TBA ETag handling;
- TBA Cache-Control max-age handling;
- 304 expiry refresh;
- match-result reconciliation when TBA returns an older/incomplete match representation.

The application-facing service is `src/lib/tba/service.ts`.

## Generated types

Never hand-edit `src/lib/tba/generated.ts`.

Regenerate with:

```bash
npm run generate:tba-types
```

`src/lib/tba/types.ts` contains ergonomic application aliases and composed application types.

## File organization

Current major boundaries:

- `src/app` — pages and API route handlers.
- `src/components/event` — event-level footer/rankings/time UI.
- `src/components/eventview` — EventView, settings, and event hooks.
- `src/components/match` — MatchStrip and MatchCard.
- `src/components/multiview` — Multiview presentation and controller.
- `src/components/team` — team UI.
- `src/lib/gameday` — match and stream utilities.
- `src/lib/multiview` — pure Multiview layouts.
- `src/lib/tba` — generated/raw TBA types, client, service, and API helpers.
- `src/lib/realtime` — Redis Pub/Sub and WebSocket bridge.

## Legacy areas

Simple/team match helpers in the TBA service remain compatibility helpers. Do not make them part of the primary Gameday realtime path.

## Dead-file cleanup

Before deleting a file:

1. Search the entire repository for references.
2. Check imports, not only matching symbol names.
3. Verify that a similarly named replacement is actually used.
4. Delete only after confirming there are no live callers.

Prefer small, focused cleanup commits.

## Coding approach

- Keep data fetching in hooks/services rather than presentation components where practical.
- Keep Multiview state transitions explicit.
- Keep WSS payloads small.
- Avoid excessive forensic logging in normal request paths.
- Do not re-add removed post-write verification requests.
- Do not hardcode external cache lifetimes.
- Do not mix a broad directory restructure into routine cleanup.
- Update README.md and this file when architectural behavior changes materially.

## Other agent documentation

`CLAUDE.md` currently points to `AGENTS.md`. Keep those instructions aligned.
