# Agent Instructions

## Project

FieldView / FRC Gameday is a Next.js 16.2.4 application for live FIRST Robotics Competition event presentation.

Read this file before modifying the project. The codebase is in a stabilization and cleanup phase after several architectural rewrites.

## Branch

Use main unless the user explicitly requests another branch.

## Core architecture

The intended flow is:

~~~
TBA REST / webhooks
       ↓
     Redis
       ↓
 Redis Pub/Sub
       ↓
 WebSocket
       ↓
GamedayWidget
   ├── matches
   ├── teams/statuses
   ├── playoff alliances
   └── webcast presentation

Polling is fallback reconciliation.
~~~

Rules:

1. Redis is the server-side cache.
2. TBA webhooks are the preferred realtime mutation path.
3. Webhooks mutate the existing Redis cache before broadcasting WSS.
4. WSS messages are invalidation signals, not data payloads.
5. Clients refetch after WSS.
6. Polling reconciles missed webhooks.
7. Do not introduce another cache layer to support webhooks.
8. Do not hardcode TBA Cache-Control max-age values.
9. The full event /event/<event>/matches cache is the canonical match cache for current Gameday.
10. Do not reintroduce old simple/team match caches into the primary realtime path.

## TBA webhook authentication

Endpoint: /api/tba/webhook

Authenticate X-TBA-HMAC before parsing JSON.

- Missing HMAC header → HTTP 418 intentionally.
- Invalid HMAC → HTTP 401.
- Authenticated malformed JSON → HTTP 400.
- Internal/configuration failure → HTTP 500.

Current message handling:

- match_score → mutate canonical event match cache.
- match_video → mutate canonical event match cache.
- upcoming_match → merge into cached match data.
- alliance_selection → update event cache when possible and let clients refetch derived data.
- schedule_updated → refetch signal.
- starting_comp_level → refetch signal.
- awards_posted → refetch signal for now.
- verification/ping/broadcast → acknowledge without match mutation.
- unknown types → acknowledge and log.

Broadcast only after successful cache processing. A WSS failure must not turn a successful Redis mutation into a failed webhook response.

## Client realtime behavior

useWebSocket connects to /api/ws?event=<eventKey> and reconnects with exponential backoff capped at 30 seconds.

GamedayWidget currently handles:

- upcoming_match, match_score, match_video → reload matches and team statuses.
- starting_comp_level, schedule_updated → broad live-data refresh.
- alliance_selection → reload alliances, statuses, and matches.
- unknown message types → broad live-data refresh.

Keep the manual r refresh behavior unless the user explicitly changes it.

## Polling

usePolling is shared fallback infrastructure.

Current intervals:

- realtime: 1 second
- fast: 5 seconds
- intermediate: 5 minutes
- long: 15 minutes

Its generation counter is intentional.

A reload must invalidate older work, cancel the old timer, run the current callback, and allow only the newest generation to schedule the next fallback.

Do not replace this with a naive setInterval implementation.

## Match semantics

The client-side canonical match helpers are in src/lib/gameday/matchUtils.ts.

Next match means the first chronologically sorted match whose alliance score is -1.

Do not use actual_time or score_breakdown as the sole next-match criterion.

TBA may provide scores while score_breakdown is null, and actual_time may be null.

The presentation chain is:

~~~
useMatches → GamedayWidget → MatchStrip → MatchCard
~~~

useMatches also contains stale-response protection. An async response may update state only if it belongs to the current event and is still the newest request generation. Preserve this protection.

## Multiview

MultiviewClient owns presentation state:

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

The streams array is the stable set of GamedayWidget instances.

NEVER reorder streams merely to change priority. Priority determines which existing streams occupy layout slots. This separation prevents React remounts and webcast reloads.

Highlighting may promote an event to slot zero without permanently modifying priority.

Layouts are pure data in src/lib/layouts.js.

Current keyboard model:

- 1–9: highlight stream.
- 0: clear highlight.
- Ctrl+1–9: choose stream for priority editing.
- Arrow Up/Down: move priority item.
- - / =: cycle explicit layout.

Do not restore old positional TeamPill modes. TeamPills are inherently horizontal; Multiview controls visibility.

## Gameday hooks

Keep responsibilities specialized:

- useEvent — event.
- useMatches — canonical full matches and event next/last.
- useTeams — teams.
- useTeamsStatuses — statuses.
- usePlayoffAlliances — playoff alliances.
- useTrackedMatches — tracked-team derivation.
- useStreamController — stream normalization/selection.
- useWebSocket — WSS lifecycle.
- usePolling — fallback scheduling.
- useNexus — retained Nexus/testing path.

Avoid rebuilding a monolithic useGameday hook.

## Event timezone

/api/events/active interprets start_date and end_date using the event's own timezone.

This intentionally makes active-state results consistent for all users regardless of browser timezone.

Do not replace this with browser-local comparisons.

## TBA client

src/lib/tbaClient.ts owns low-level TBA REST and Redis cache behavior.

Preserve:

- Redis-backed caching.
- TBA ETag handling.
- TBA Cache-Control max-age handling.
- race protection against stale TBA responses overwriting webhook-mutated Redis data.
- 304 expiry refresh.
- canonical full-match cache mutation.

Do not add redundant post-write verification GETs or another cache layer unless the architecture is explicitly changed.

src/lib/tbaService.ts is the application-facing service used by API routes.

## Generated types

Never hand-edit src/lib/tba/generated.ts.

Regenerate with:

~~~
npm run generate:tba-types
~~~

src/lib/tba/types.ts contains ergonomic application aliases.

## File organization

Current major boundaries:

- src/app — pages and API route handlers.
- src/components/gameday — event-level UI.
- src/components/gameday/hooks — specialized client hooks.
- src/components/gameday/navbar — MatchStrip/MatchCard/event-local-time.
- src/components/gameday/teamElements — team UI.
- src/components/multiview — Multiview presentation orchestration.
- src/lib/gameday — Gameday utilities.
- src/lib/tba — generated/raw TBA types.
- src/lib/tbaClient.ts — low-level TBA + Redis cache.
- src/lib/tbaService.ts — application TBA service.
- src/lib/websocket.ts — Redis Pub/Sub → WebSocket bridge.
- src/lib/layouts.js — pure Multiview layouts.
- src/lib/nexus — Nexus types.
- src/lib/cast — Cast support.

## Legacy areas

Treat these as compatibility/legacy areas until their call graphs are audited:

- src/lib/eventState.ts
- src/app/api/admin/redis/*
- simple/team match helpers in tbaService.ts
- Nexus integration/testing
- generic cache tag machinery

Do not delete them merely because they are not part of the primary Gameday flow.

## Dead-file cleanup

Before deleting any file:

1. Search the entire repository for references.
2. Check imports, not only matching symbol names.
3. Verify that a similarly named replacement is actually used.
4. Delete only after confirming there are no live callers.

Recent examples:

- useStreamController.js was superseded by useStreamController.ts.
- src/lib/gameday/getMatchesForTeams.ts was superseded by matchUtils.ts.
- Legacy LastMatch.jsx and NextMatch.jsx presentation components were superseded by MatchStrip/MatchCard and matchUtils.

Dead-file cleanup is intentionally separate from the planned future directory reorganization.

## Coding approach

- Prefer small, focused changes.
- Preserve working behavior unless the user explicitly asks for a behavior change.
- Keep data fetching in hooks/services rather than presentation components where practical.
- Keep Multiview state transitions explicit.
- Keep WSS payloads small.
- Avoid excessive forensic logging in normal request paths.
- Do not re-add removed post-write verification requests.
- Do not hardcode external cache lifetimes.
- Do not mix a broad directory restructure into routine cleanup.
- Update README.md and this file when architectural behavior changes materially.

## Other agent documentation

CLAUDE.md currently points to AGENTS.md. Keep those instructions aligned.
