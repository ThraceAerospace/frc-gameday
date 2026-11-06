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

Live route layouts under `src/app/gameday`, `src/app/event`, and `src/app/insights` register a shared live-runtime lease. One origin-wide SharedWorker owns the physical WebSocket at `/api/ws`, its event-key subscriptions, the EventState map, and all event acquisition. Tabs receive EventState snapshots over MessagePorts; a tab must not create its own EventState or per-tab WebSocket when SharedWorker is available.

The worker sends `subscribe`/`unsubscribe` messages for event keys, reconnects with exponential backoff, and resubscribes active keys after reconnect. EventState still owns the per-event refresh and reconciliation policy, but its instances live in the worker. WSS messages remain invalidation signals. Preserve the 65-second authoritative refetch delay, request-race protection, tag invalidation, ETag/304 behavior, and the manual `r` refresh behavior. Remote displays consuming EventStateSnapshotsProvider remain read-only and must not subscribe to worker event acquisition. When all live clients leave, close the socket and stop event timers; do not keep an idle worker connection open.

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

Team presentation rules:

- Show teams in their red or blue alliance color only when displaying a match; outside match context, use neutral black styling.
- When a match's alliance data includes a team in `dq_team_keys`, render that team's number with a strikethrough.

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
- Read Statbotics values directly from the typed response object; do not coerce/cast individual values to another numeric type. Format displayed metrics to at most one decimal place for readability, without modifying the underlying response. Show alliance totals by summing all three teams’ estimates; show `—` until every team value for that metric is available.

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

## Event timezone — core presentation principle

**All dates, times, and datetimes displayed by the application must use the event's timezone.** This is a core product principle, not merely a default formatting preference.

- Use the event's IANA timezone for displayed schedules, match times, date labels, timestamps, and other event-related date/time values.
- Countdown clocks and time-based UI must use the same event-time basis, so the application's clocks agree with the time announced at the venue.
- Do not display event dates or times in the viewer's browser/system timezone, and do not silently fall back to browser-local formatting.
- The viewer's local time is already available from their system clock. The application does not need to duplicate it.
- A next-match countdown communicates the relative time until the match; once a countdown is shown, the viewer does not need a timezone conversion to understand it.
- Treat event time as the canonical presentation context throughout the application, including pages that aggregate or compare multiple events. When showing multiple events, each event's displayed date/time must be formatted in that event's own timezone.

The goal is consistency with the venue: the time shown by FieldView should match what event announcers and field staff are using.

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

- Always use Tailwind CSS utilities where they provide the needed styling; do not add custom CSS for styles Tailwind already supports.
- Do not duplicate logic that already exists; search for and reuse existing helpers. For date/time parsing, formatting, and timezone behavior, use `src/lib/time`. If a needed helper is missing, add it there for reuse.
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


## Event Analytics prototype

- The standalone event analytics route is `/insights/event/<event>`. Its UI and analytics pipeline remain independent of Gameday tile/remote-session configuration, but its live event context must use `useEventState` and the shared `/insights` live-runtime layout. Do not create a second WebSocket or duplicate EventState.
- `src/lib/insights` contains server-side calculations and orchestration. It consumes TBA/Statbotics services; Views must not call upstream APIs directly.
- Event analytics collection is a resumable server-side job stored in Redis. The route returns the current complete-so-far snapshot and uses Vercel `waitUntil` to advance bounded Statbotics match batches; the browser polls only collection status/results and never requests a "next page". Preserve the worker lock, execution budget, retry limits, and bounded concurrency. Refresh the TBA match schedule and OPR periodically; WebSocket/EventState updates trigger immediate refresh of the latest completed match. Do not create a second WebSocket or move calculations into the browser.
- Derived event pages use a short Redis cache and a request lock. Do not turn Redis into permanent season-history storage.
- Residuals are alliance-level, rating changes are model updates, and partner-combination signals are contextual. Never attribute these to an individual robot.
- Every event team should receive the same concise, bullet-first team brief, followed by supporting analytics, graphs, match pointers, and review flags. Review flags identify correlations/anomalies for a human scout to investigate; they are not causal determinations. Never attribute alliance score residuals, win-probability mismatches, partner patterns, or shared EPA updates to an individual robot.
- Model percentiles are event-relative. Keep model provenance, sample size, and uncertainty visible.
- Scout review/dismiss actions in this prototype are browser-local only; do not imply that they are shared or persistent.

- Team season history is loaded only for teams selected in the comparison UI. Filter TBA event type 99 (offseason) and 100 (preseason); use the cached Statbotics `team_year` and `team_event` endpoints through `Statbotics`, never direct browser requests.


## Homepage event snapshot

- The homepage (`src/app/page.tsx`) is a Server Component with one-hour ISR (`revalidate = 3600`). It renders the current Sunday–Saturday event list and event summaries into the initial HTML.
- Retrieve each event's canonical full match schedule through `TBA.getEventMatches`; derive last/next matches with the shared `sortMatches`, `getLastMatch`, and `getNextMatch` helpers in `src/lib/tba/matchUtils.ts`.
- Reuse the existing TBA Redis cache and its upstream-controlled freshness. Do not introduce a homepage-specific match cache, browser polling, or a homepage WebSocket subscription.
- Event cards are server-rendered and reuse the existing `MatchCard` presentation for last/next matches. A match-summary fetch failure for one event must not prevent the other event cards or homepage from rendering.


## Homepage event snapshot

- The homepage (`src/app/page.tsx`) is a Server Component with one-hour ISR (`revalidate = 3600`). It renders the current Sunday–Saturday event list and event summaries into the initial HTML.
- The complete homepage data snapshot is wrapped in `unstable_cache` with a one-hour revalidation period. It retrieves each event's canonical full match schedule through `TBA.getEventMatches` and derives last/next matches with the shared `sortMatches`, `getLastMatch`, and `getNextMatch` helpers in `src/lib/tba/matchUtils.ts`.
- Reuse the existing TBA Redis cache and its upstream-controlled freshness. Do not introduce a separate homepage match cache, browser polling, or a homepage WebSocket subscription.
- Event cards are server-rendered and reuse the existing `MatchCard` presentation for last/next matches. A match-summary fetch failure for one event must not prevent the other event cards or homepage from rendering.


## Analytics architecture — core principles

The analytics experience has four scopes: Event Overview, Team Analysis, Matchup Analysis, and supporting Scouting Tools. Event Overview is the default entry point; scouting review queues are not the product's primary landing view.

Analytics calculations and conclusions are server-authoritative. The browser presents results, manages view selection, and requests a new analysis when its inputs change; it must not fetch TBA/Statbotics directly or independently reproduce statistical models used by the server.

Keep analytics business logic independent of HTTP handlers and the hosting runtime. Vercel route handlers and `waitUntil` are execution adapters, not dependencies of calculation or orchestration services. A future persistent worker must be able to invoke the same service functions without changing the client API.

Long-running collection and computation must be bounded, persistent, resumable, and recoverable. Redis job state—not a serverless process's memory or lifetime—is authoritative. Persist progress and retry state before yielding; use locks with finite TTLs and ensure abandoned work can be resumed by a later invocation.

Prefer incremental processing. A changed match should refresh that match and the derived results it affects rather than requiring a complete event recollection. Periodic source reconciliation remains necessary for schedule, roster, rankings, and OPR changes.

Track source-data freshness separately from calculation freshness. Preserve the source update time, calculation time, and calculation/schema version wherever derived snapshots are cached so changed source data and changed algorithms can be distinguished and invalidated deliberately.

Treat alliance-level results, team-level model estimates, official qualification rankings, and robot-specific scouting observations as different evidence types. Do not attribute alliance score residuals or shared model updates to an individual robot.


## Elimination performance shift analysis

The season-long team match analysis calculates a qualification-to-elimination score-residual shift separately for each official event. Only events with at least three scored qualification matches and two scored elimination matches with usable pre-match Statbotics predictions are eligible. Each event contributes one shift to the season summary so events with larger playoff schedules do not dominate. The summary reports mean/median event shift, negative-shift event count, and a one-sided exact sign test across event-level shifts. A recurring-negative label requires at least three eligible events, at least three negative shifts, and sign-test p ≤ 0.05. This is an exploratory association in alliance-level residuals, not proof of robot-level underperformance or choking. The first-pass calculation is not yet adjusted for partner/opponent strength; the UI states this limitation explicitly. Match keys for the qualification and elimination evidence are retained for direct match review.
