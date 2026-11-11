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

Never hand-edit `src/lib/tba/generated.ts` or `src/lib/statbotics/generated.ts`.

Regenerate with:

```bash
npm run generate:tba-types
npm run generate:statbotics-types
```

Both generators fetch the current upstream OpenAPI documents. Statbotics fallback response schemas fill only missing fields and generic response definitions; existing upstream fields and types always take precedence. When Statbotics adds or corrects response models in OpenAPI, generation adopts those definitions automatically, after which the corresponding fallback fields can be removed. Keep application-facing aliases in `src/lib/tba/types.ts` and `src/lib/statbotics/types.ts`.

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
- FRC team colors use the provider in `src/lib/frc-colors/`. The progressive event analytics collection job acquires the event's colors through the FRC Colors batch event endpoint, caches them in Redis for 24 hours, and persists the result in the event job. Do not add a browser/page-level color request or a request per match. Use primary colors only for robot EPA-bar segments; missing or colliding colors must use distinct fallbacks. A manual analytics refresh may refresh the provider cache.
- `% EPA Contribution to Matches` is the team's pre-match total EPA divided by the sum of all three alliance robots' pre-match total EPAs, averaged across every usable qualification and elimination appearance. Keep the reusable metric and sample count phase-inclusive; qualification match rows may show the per-match share prominently. This is a model-estimate composition measure, not a share of actual match points or an attribution of scoring to a robot.
- Statbotics uses `https://api.statbotics.io` by default. Keep `STATBOTICS_API_BASE_URL` as an explicit override for a compatible self-hosted instance. All upstream requests must go through `src/lib/statbotics/client.ts` and the application-facing `src/lib/statbotics/service.ts`; consumers must not fetch Statbotics directly. Honor upstream `Cache-Control: max-age` when present, with a conservative 10-minute minimum between requests for the same resource. If max-age is absent, use a 10-minute fallback for match/team-year records and 24 hours for team-event records. Preserve stale data on failures and back off failed requests. Event-level analytics workers are limited to two concurrent Statbotics match requests.
- Event analytics collection is a resumable server-side job stored in Redis. The route returns the current complete-so-far snapshot and uses Vercel `waitUntil` to advance bounded Statbotics match batches; the browser polls only collection status/results and never requests a "next page". Preserve the worker lock, execution budget, retry limits, and bounded concurrency. Refresh the TBA match schedule and OPR periodically; WebSocket/EventState updates trigger immediate refresh of the latest completed match. Do not create a second WebSocket or move calculations into the browser.
- Derived event pages use a short Redis cache and a request lock. Do not turn Redis into permanent season-history storage.
- Residuals are alliance-level, rating changes are model updates, and partner-combination signals are contextual. Never attribute these to an individual robot.
- Every event team should receive the same concise, bullet-first team brief, followed by supporting analytics, graphs, match pointers, and review flags. Review flags identify correlations/anomalies for a human scout to investigate; they are not causal determinations. Never attribute alliance score residuals, win-probability mismatches, partner patterns, or shared EPA updates to an individual robot.
- Model percentiles are event-relative. Keep model provenance, sample size, and uncertainty visible.
- Scout review/dismiss actions in this prototype are browser-local only; do not imply that they are shared or persistent.

- Team season history is loaded only for teams selected in the comparison UI. Filter TBA event type 99 (offseason) and 100 (preseason); use the cached Statbotics `team_year` and `team_event` endpoints through `Statbotics`, never direct browser requests.

- Prefer Statbotics bulk collection endpoints whenever a filtered collection can satisfy the request: `/v3/matches?event=...`, `/v3/matches?team=...&year=...`, and `/v3/team_events?team=...&year=...`. Use paginated collection methods (up to 1000 records per page) through the shared Statbotics client/service; preserve per-query caching, upstream Cache-Control, and the shared request floor. Use single-record endpoints for targeted live-match refreshes or when a collection endpoint cannot express the lookup.
- Start independent TBA and Statbotics collection requests concurrently. Do not serialize unrelated event metadata, schedule, rankings, OPR, match collection, or team-event collection fetches. Merge bulk Statbotics records into the canonical TBA schedule by match/event key; TBA remains authoritative for schedule and actual results.
- Persist usable bulk results and retain previously collected records if a later refresh fails or omits a record. Distinguish a failed collection request from a successful collection response that contains no record for a scheduled match. The browser must keep displaying the latest complete-so-far analytics snapshot while polling, reject stale overlapping responses, and show a sticky progress/status area at the top of the analytics page with explicit missing-data explanations.


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

The analytics experience has distinct scopes: Event Overview, Team Investigation, Qualification Analysis, Playoff Analysis, Matchup Analysis, and supporting Scouting Tools. Event Overview is the default entry point; scouting review queues are not the product's primary landing view. Team Investigation loads one selected team at a time.

Analytics calculations and conclusions are server-authoritative. The browser presents results, manages view selection, and requests a new analysis when its inputs change; it must not fetch TBA/Statbotics directly or independently reproduce statistical models used by the server.

Keep analytics business logic independent of HTTP handlers and the hosting runtime. Vercel route handlers and `waitUntil` are execution adapters, not dependencies of calculation or orchestration services. A future persistent worker must be able to invoke the same service functions without changing the client API.

Long-running collection and computation must be bounded, persistent, resumable, and recoverable. Redis job state—not a serverless process's memory or lifetime—is authoritative. Persist progress and retry state before yielding; use locks with finite TTLs and ensure abandoned work can be resumed by a later invocation.

Prefer incremental processing. A changed match should refresh that match and the derived results it affects rather than requiring a complete event recollection. Periodic source reconciliation remains necessary for schedule, roster, rankings, and OPR changes.

Track source-data freshness separately from calculation freshness. Preserve the source update time, calculation time, and calculation/schema version wherever derived snapshots are cached so changed source data and changed algorithms can be distinguished and invalidated deliberately.

Treat alliance-level results, team-level model estimates, official qualification rankings, and robot-specific scouting observations as different evidence types. Do not attribute alliance score residuals or shared model updates to an individual robot.

Matchup probability labels use five red-win-probability bands: Strong Red (80–100%), Lean Red (60–80%), Toss-up (40–60%), Lean Blue (20–40%), and Strong Blue (0–20%). Boundaries are left-inclusive except the final 100% endpoint. A model upset is a completed match in which the pre-match favorite had at least a 60% win probability and lost; keep this separate from score-residual anomalies.

Team event EPA share is the mean of each team's pre-match EPA divided by the sum of all three alliance teams' pre-match EPA, calculated only for matches with all three nonnegative team EPA values and a positive alliance total. Show the number of qualifying matches. This is an expected model share, not observed point attribution. Team season-match charts support All, Qualification, and Playoff phase filters plus any combination of Auto, Teleop, and Endgame components.


## Elimination performance shift analysis

The season-long team match analysis calculates a qualification-to-elimination score-residual shift separately for each official event. Only events with at least three scored qualification matches and two scored elimination matches with usable pre-match Statbotics predictions are eligible. Each event contributes one shift to the season summary so events with larger playoff schedules do not dominate. The summary reports mean/median event shift, negative-shift event count, and a one-sided exact sign test across event-level shifts. A recurring-negative label requires at least three eligible events, at least three negative shifts, and sign-test p ≤ 0.05. This is an exploratory association in alliance-level residuals, not proof of robot-level underperformance or choking. The first-pass calculation is not yet adjusted for partner/opponent strength; the UI states this limitation explicitly. Match keys for the qualification and elimination evidence are retained for direct match review.


## Season-wide cohort analytics

Event Insights builds a Redis-backed, resumable season cohort for every team on the target event roster. For each team, it discovers all official-season events (excluding TBA event types 99 offseason and 100 preseason), then retrieves Statbotics team-event snapshots through the configured Statbotics API endpoint (the API-compatible mirror is the default; response contracts use the official Statbotics v3 generated schema). Work is bounded by a 20-second execution budget, two concurrent upstream requests, small batches, up to three discovery attempts per team, a finite lock, and a 24-hour job TTL. Team-event snapshots use the shared Statbotics cache policy (24-hour fallback); the current target event is collected during discovery and is refreshed only by an explicit cohort refresh. This avoids fan-out requests from the browser and avoids collecting every season match for every event team.

The team brief compares the target event EPA total-points value with that team's most recent preceding official event, then ranks the change against all event-roster teams with usable prior/current snapshots. Every event-roster team is eligible regardless of which prior event it attended; do not require a shared prior event. Select the most recent preceding official event by date before checking Statbotics availability. If that event has no usable Statbotics team-event record, do not silently fall back to an older event: leave that team's change/rank unavailable while retaining the team in all current-event views. Overall EPA and each EPA component are ranked independently; each component rank's denominator includes only teams with both current and prior values for that component. Always display the eligible comparison count and make clear that teams may have different prior-event baselines. Coverage and failed records remain visible. These cross-event differences can include timing, event strength, model updates, and game-context effects; the comparison is descriptive and not a causal or direct robot contribution measure.

The selected-team match-history endpoint adds an event-normalized residual pattern. It compares the selected team's mean alliance score residual with opposing alliances from the same matches whose pre-match combined EPA is within ±20% of the selected alliance strength. It requires at least three team matches and six strength-matched opponent residuals per event, then tests whether below- or above-baseline directions recur across events. This is an approximate peer sample from matches featuring the team, not an independent event-wide calibration sample. It cannot separate the selected team from its partners or opponents.


## Analytics presentation hierarchy

- Every analytics scope must lead with a concise plain-language answer to the question that scope is meant to answer. Present the interpretation before the supporting numbers.
- Follow the takeaway with a small number of directly relevant evidence elements: comparisons, charts, and match links. Move raw tables, secondary metrics, statistical tests, model diagnostics, and methodology into clearly labeled disclosures.
- Event Overview should explain the current competitive picture before exposing standings and model diagnostics. Team Investigation should lead with a single-team strength profile, expectations and peer context, event/season progression, and season-wide anomaly matches worth reviewing. Matchup Analysis should state the recorded result before alliance/model detail. Scouting Tools should prioritize reviewable evidence over aggregate diagnostic charts.
- Do not hide important caveats or sample coverage. Keep them concise and close to the conclusion they qualify.
- A summary statement must be traceable to the data shown nearby. Distinguish observed change, comparison with a defined cohort, and a prompt for human investigation. Never turn a statistical association into a causal explanation.


## Team, qualification, and playoff investigations

- Team Investigation is a one-team-at-a-time workflow. Its questions are absolute strength, performance relative to expectations, development within/across events, strength-matched peer-relative performance, and season-wide unusual matches involving that team.
- Team peer comparisons use pre-match combined alliance EPA to find other event alliances within ±20% of the selected team's alliance strength. Compare alliance residuals, not individual robot output; require at least three selected-team matches and five peer alliance results before interpreting the comparison.
- Team match anomaly flags use the selected team's season residual median and median absolute deviation (MAD), with a minimum of eight scored observations. High-confidence losses are separately flagged when the model assigned the team's alliance at least 80% win probability and it lost. Opponent anomalies are contextual. All flags identify matches to inspect and do not establish robot-level causation.
- Qualification Analysis is event-wide and includes qualification matches only. Flag alliance score residuals outside a robust event-calibrated band (median ± max(20 points, 3 × 1.4826 × MAD)) and high-confidence win-probability misses (at least 80% predicted win probability but the alliance lost). The score band is estimated from observed event residuals; Statbotics does not provide a score prediction interval in this integration. Do not call it a model-provided confidence interval.
- Playoff Analysis is separate from qualification analysis. It groups completed elimination alliance results by three-team composition and summarizes residuals by elimination round. Team elimination progression remains season-wide and event-balanced, requiring at least three scored qualification matches and two scored elimination matches per event. A recurring-negative pattern requires at least three eligible events and an exact one-sided sign-test p-value ≤ 0.05 after positive qualification baselines; it is an alliance-level association, not proof of robot-level choking.
- Every anomaly and conclusion must link to supporting match evidence, expose sample coverage, and distinguish observed alliance outcomes from robot-specific scouting observations.

## Reusable insight components — core architectural principle

**Reusability, Reusability, Reusability.**

FieldView must be built around independently reusable insight components. This is a core architectural requirement for all future analytics development and the continued refactoring of existing dashboards.

### Insights are independent of dashboards

The dashboard is a composition of insights, not the exclusive home of those insights. Every metric, statistic, value, comparison, visualization, indicator, review flag, summary, and other discrete analytical element should be implemented as a self-contained React component that can be placed anywhere in the application.

A component must work when supplied with the appropriate data through its props. It must not depend on being rendered inside a particular dashboard, tab, page, or parent component.

### Build from the smallest useful units

Break analytics down into reusable components at every appropriate level, including:

- Individual metric values and formatted statistics.
- Performance indicators, trends, and comparisons.
- Win-probability classifications and prediction summaries.
- Team and alliance contribution indicators.
- Statistical distributions, confidence intervals, and error measurements.
- Charts and their filtering controls.
- Match review flags and anomaly indicators.
- Summaries and higher-level analytical insights.

Components should be composable: larger insight components should be assembled from smaller reusable components rather than reimplementing their functionality.

### Separate data, calculations, and presentation

Reusable insight components must have clear, explicit data contracts.

- Data acquisition belongs in appropriate data services and application-level data flows, not in individual presentation components.
- Calculations and analytical methodology belong in reusable, independently testable functions or services.
- Presentation belongs in reusable React components that receive the data they need through props.

Do not duplicate calculations or analytical methodology across different pages. The same metric must mean the same thing wherever it appears.

### Avoid dashboard-specific dependencies

Insight components must not assume dashboard-specific state, routing, layout, navigation, or data-fetching behavior.

Where an insight requires configuration, filtering, or interaction, expose the necessary behavior through explicit props and well-defined interfaces. Components should support different presentation contexts, including compact and expanded layouts, without duplicating the underlying analytical implementation.

### Compose dashboards from reusable insights

Dashboards should primarily be composition layers. Their responsibility is to organize, arrange, and contextualize existing insight components. They should not become monolithic implementations containing analytics that cannot be reused elsewhere.

When a new insight is developed for a dashboard, it must be designed for reuse from the beginning.

### Make insights available throughout FieldView

The long-term goal is to distribute useful analytical information throughout the entire application. The same insight should be usable on:

- Team pages.
- Event pages.
- District pages.
- Match cards and match detail views.
- Event and team dashboards.
- Remote displays and single-field presentations.
- Other future application surfaces.

A user should not need to open a dedicated analytics dashboard to benefit from FieldView's analytical capabilities.

### Maintain and verify reusability

Before implementing a new metric or insight, check whether an existing component or analytical function can be reused or extended. Avoid duplicate components that represent the same underlying metric. Prefer shared components with explicit props and sensible configuration over separate implementations for individual pages.

Add appropriate tests for shared calculations and reusable components. Changes to an insight's methodology or presentation must remain consistent across every place that uses it.

**Guiding principle: Build an insight once. Make it available everywhere.**

## Shared layout and page data boundaries

- `SiteShell` is a presentation/layout component for shared site chrome (navigation, theme controls, and the page content frame). It must not fetch TBA data, require event/team collections as props, or make individual pages load data solely to satisfy the shell.
- Pages and route-level data services fetch only the data their own content requires. Do not call `TBA.getEvents(year)` globally or on every page to populate shared navigation.
- If navigation genuinely needs contextual information, derive it from the current route or pass the smallest already-available value. Do not introduce a full event-list fetch for navigation state.
- Keep page-specific collections local to the page that uses them. Do not pass unused data through shared layout components.

## Explicit authorization required for new page data fetches

**No agent may add a data fetch to any page without explicit authorization from the user. This is a hard requirement.**

- Do not add a new TBA, Statbotics, database, Redis, internal API, external API, or other data request to a page or page-specific data-loading path unless the user has explicitly authorized that fetch.
- This applies whether the request is made directly by a Server Component, through a helper/service, in a client effect or hook, or indirectly through a shared layout or component.
- Before proposing or implementing a new fetch, inspect the page's existing data flow and determine whether the required data is already available through an existing snapshot, service result, cache, or shared state.
- Never add a broad collection fetch (for example, `TBA.getEvents(year)`) merely to supply navigation, shared layout, or unrelated page context. Fetch only the narrow resource the page actually needs, and only when that fetch has been explicitly authorized.
- Reusing, relocating, or refactoring an existing authorized fetch is not permission to introduce additional upstream requests or expand its scope.
- If a feature appears to require new data acquisition, stop before changing code and ask the user for explicit authorization. Explain the proposed source, scope, trigger/frequency, and why existing data flows cannot satisfy the requirement.
- Do not interpret a general feature request, bug report, or instruction to improve a page as authorization to add new data fetching. Authorization must specifically cover the proposed fetch.
- When authorized, keep acquisition in the appropriate shared service/data layer, preserve existing caching and freshness rules, and avoid duplicating requests across pages or components.

This rule applies to all agents and all future work. Existing page fetches may be maintained or corrected; this requirement governs adding new fetches.

## Match flags and Suggested Review presentation

- Keep alliance-level and match-level indicators separate. Inside each alliance panel, place the three team numbers and four match metrics in the top section, then use the entire bottom width of the alliance panel for a wrapping row of applicable flags. The metric order is **Win Chance → Predicted Score → Score Delta → Actual Score**. The flag row begins with **Win** or **Loss** (dark alliance color, based on the actual result), then **Predicted Win** or **Predicted Loss** (light alliance color, according to the model's favored side), followed by any applicable alliance review flags such as **High Alliance EPA**, **Large Score Delta**, and **High Penalties** (shared amber review color). Flags must not be constrained to the team-number column; allow the row to wrap as needed. Do not render placeholder badges for unavailable or inapplicable states.
- The match-flags row owns the five-band election-style win-probability classification (Strong Red, Lean Red, Toss-up, Lean Blue, Strong Blue) and match-level review flags. Use the five red-to-blue classification colors for the probability label; use the shared amber highlight color for review flags.
- **Model Upset** means a completed match where the pre-match favorite had at least 60% win probability and lost.
- **Anomalous Score** means an alliance actual-minus-predicted residual outside the match-phase event baseline of median ± max(20 points, 3 × 1.4826 × MAD), requiring at least eight usable alliance residuals in that phase. This is an event-relative review signal, not a model-provided confidence interval.
- **Large Score Delta** is alliance-specific and appears inside the affected alliance panel, not in the match-flags row. Flag an alliance when its absolute actual-minus-predicted score delta is in the event-wide top decile, requiring at least 20 usable alliance residuals. It remains a Suggested Review tab; each card identifies the affected alliance and its signed delta.
- **High Alliance EPA** marks an alliance whose combined pre-match EPA estimate is in the top quartile of available alliance estimates, with at least eight usable estimates. It is a strength indicator, not an anomaly.
- **High Penalties** is alliance-specific: compare each alliance's credited foul points against the event-wide alliance penalty-point distribution using the Tukey upper fence (Q3 + 1.5 × IQR; when IQR is zero, values above the median are flagged), with at least 10 usable alliance observations. Display penalty count alongside credited penalty points; do not attribute penalties to an individual robot. TBA score-breakdown count fields are season-dependent: through 2025 use `foulCount` + `techFoulCount`; 2026 uses `minorFoulCount` + `majorFoulCount`. Accept the corresponding snake_case variants defensively. `foulPoints` remains the credited-point field.
- Suggested Review contains flagged matches, sorted by scheduled match time in the event timezone (then competition-level/match-number fallback). Group the same matches into tabs by flag type; a match with multiple flags may appear in multiple tabs. Each card should retain all of its applicable flags, show both alliances and scores, and expose the match/video links without a reviewed/dismissed workflow.
- Do not add data acquisition for this presentation. Derive flags from the existing event analytics response and its current match/video fields.
