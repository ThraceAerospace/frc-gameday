# FieldView application audit

**Audit date:** 2026-11-10  
**Branch:** `ui-cleanup`  
**Audit-start baseline:** `ui-cleanup` was 31 commits ahead of `main` and had no commits behind it. The `main` baseline at audit start was `3c779a754c55eaacd8238fbc7fe83d4dee89530c`. Documentation updates made during this audit are committed on `ui-cleanup`; the branch distance will increase as this audit record is maintained.

## Status and scope

This is the first architecture, data-flow, API, and documentation-consistency pass. It inspects the main application surfaces, the TBA/Statbotics/FRC Colors integrations, Redis caching, webhook/WebSocket delivery, SharedWorker/EventState ownership, Event Analytics orchestration, and the corresponding project documentation.

It is not yet a line-by-line review of every presentation component, every analytics formula, or every route's accessibility and error states. No local lint, build, automated test, or live-provider validation was run during this pass. Findings below are based on source inspection.

## Executive summary

FieldView already has a meaningful data architecture: TBA acquisition is centralized behind a Redis-backed service; live event state is shared through an origin-wide SharedWorker; analytics calculations are server-side; and the application has distinct event, team, district, Gameday, Insights, and remote-display surfaces.

The largest risks found in this pass are not visual. They concern provider compliance, data freshness, and differences between the documented and implemented analytics lifecycle:

1. The Statbotics client currently defaults to a community-operated mirror, contrary to the project's stated provider requirement.
2. The assembled team-history API response is cached for one year even for the current season, and the route has no explicit refresh parameter.
3. Event Analytics documentation describes a background/polling workflow that the current route and dashboard do not implement.
4. The WebSocket bridge forwards the original webhook `messageData`, including full match payloads, even though clients primarily use the messages as invalidation signals.
5. The EventAnalytics source envelope does not fully describe optional TBA source failures.

These should be resolved before treating the data layer as ready for a public beta.

## Application surfaces

The inspected application routes and surfaces include:

- `/` — server-rendered current-week event snapshot, cached for one hour.
- `/events` — current-season event browser.
- `/teams` and `/team/[team]` — current-season team directory and team detail.
- `/districts` and `/district/[district]` — district directory and district detail.
- `/event/[event]` — event detail.
- `/gameday` and divisional Gameday surfaces — client-side Tile View / Multiview presentation.
- `/insights` and `/insights/event/[event]` — analytics entry point and event analytics workspace.
- `/remote` and `/remote/display` — remote controller and display surfaces.

The teams directory currently renders at most the first 200 teams and explicitly indicates that team search is not yet implemented.

## Current data architecture

### The Blue Alliance

- The low-level client is `src/lib/tba/client.ts`; application-facing methods are in `src/lib/tba/service.ts`.
- Redis stores TBA response data together with ETag and expiry metadata. The client honors upstream `Cache-Control: max-age`, sends conditional requests, refreshes expiry on 304 responses, and reconciles completed match results against older/incomplete upstream representations.
- The full event match schedule (`/event/<event>/matches`) is the canonical schedule used by the live event path.
- `POST /api/tba/webhook` authenticates `X-TBA-HMAC` before parsing JSON. It mutates an existing event match cache when a webhook contains usable match data, then publishes an event-scoped update through Redis Pub/Sub.
- `/api/ws` bridges Redis Pub/Sub channel `gameday:tba` to connected WebSocket clients. The server-side WebSocket message includes the webhook's `messageData`; it is not currently reduced to a minimal invalidation envelope.
- The TBA client does not currently coalesce simultaneous cold-cache requests for the same endpoint. Its Redis re-read protects against overwriting a newer concurrent cache mutation, but multiple callers can still issue duplicate upstream requests on a cache miss.
- The 65-second webhook-triggered EventState timer is a one-shot API re-read, not a change to Redis `expiresAt` and not a guarantee that an upstream TBA request will occur at that moment.

### EventState and live delivery

- `src/lib/events/EventState.ts` owns the client-side event snapshot and its acquisition/reconciliation lifecycle: event metadata, teams, full matches, team statuses, playoff alliances, OPRs, and targeted Statbotics next/last-match data.
- `src/lib/events/eventState.shared-worker.ts` owns the per-event EventState map and uses `workerRealtime` for the physical WebSocket.
- `src/lib/events/sharedWorkerClient.ts` connects tabs through MessagePorts and distributes snapshots to local React subscribers. Live route layouts register a shared-runtime lease.
- The SharedWorker path is the normal path. If SharedWorker is unavailable, the client falls back to per-tab EventState instances and the browser WebSocket manager.
- EventState uses five-minute fallback reconciliation for matches, statuses, alliances, and OPRs. WebSocket updates trigger resource-specific reloads and a one-shot 65-second authoritative refetch.
- Remote displays consume controller-published EventState snapshots and do not start their own event acquisition lifecycle.

### Statbotics and FRC Colors

- Statbotics requests are centralized through `src/lib/statbotics/client.ts` and `src/lib/statbotics/service.ts`. The client supports ETags, upstream cache headers, a ten-minute minimum request interval, endpoint fallbacks, stale-on-error behavior, and retry backoff.
- The generated Statbotics type document is fetched from the official Statbotics OpenAPI endpoint. This is separate from the runtime data host: the runtime client currently defaults to `https://api-statbotics.iterativerefinement.com`, a community-operated mirror.
- FRC Colors is accessed through `src/lib/frc-colors/` and caches event colors in Redis for 24 hours.

### Event Analytics

- Calculations and orchestration live under `src/lib/insights/`; the dashboard is `src/components/insights/EventAnalyticsDashboard.tsx`.
- `EventAnalytics` v1 adds schema version, event identity, generation time, provenance, and source status to the existing analytics response. It still extends `EventAnalyticsResponse`, so the compatibility payload retains provider-shaped TBA and Statbotics records. It is not yet a provider-independent DTO.
- The event analytics job is stored in Redis with a one-year TTL. A normal open reuses the persisted event snapshot; explicit refresh reacquires the event schedule/OPR/rankings/alliances and the Statbotics/FRC Colors collections.
- `GET /api/insights/event/[event]` awaits initial snapshot creation, `advanceEventAnalytics`, and `advanceSeasonCohort` before returning. The route has `maxDuration = 60`; it does not currently use Vercel `waitUntil` for these jobs.
- The dashboard fetches the analytics endpoint on mount and on explicit refresh. It does not currently poll the endpoint for collection progress. `EventAnalyticsSurface` subscribes to EventState for live connection status, but the analytics payload itself is still acquired through the dashboard's HTTP request; it is not yet delivered by the SharedWorker.
- The season cohort is separately persisted with a 24-hour TTL and advances within a 20-second work budget.
- The selected-team history endpoint and selected-team match-analysis endpoint are separate HTTP resources.

## Verified behavior that matches the data-analysis requirements

The season-cohort comparison logic in `src/lib/insights/calculations.ts` matches the intended comparison rule: it selects each event-roster team's most recent preceding official event before checking whether the Statbotics record is usable; a missing record at that latest event excludes that team's change ranking rather than silently falling back to an older event. Teams without a usable baseline remain in the event roster/current-event views. Total-EPA ranks use the eligible comparison cohort, while Auto, Teleop, and Endgame ranks each use their own valid prior/current component denominator.

The cohort discovery path filters TBA event types 99 and 100, obtains each team's TBA event history and Statbotics team-event collection concurrently, and records unavailable event snapshots instead of dropping those events from the baseline history. This preserves the distinction between the latest preceding event and the latest preceding event with data.

The qualification anomaly calculation is server-side and uses an event-relative median/MAD band with a minimum of eight usable alliance residuals. The selected-team peer comparison is also server-side and compares qualification alliance residuals against other same-event alliances within the documented ±20% pre-match EPA band, with minimum sample requirements.

The inspected match-time presentation paths pass the event's IANA timezone into their formatters/components: EventView, EventFooter, HomeEventCard, and MatchCard. Date-only event ranges remain date-only values. This is consistent with the event-timezone invariant, although a complete component-wide timezone sweep remains part of the UI audit.

## API route audit

The following 22 App Router API handlers were inspected on `ui-cleanup`:

| Route | Current responsibility |
|---|---|
| `GET /api/district` | Current-year district list from TBA |
| `GET /api/district/all/cmp` | District teams advanced to CMP |
| `GET /api/district/[district]/advancement` | District advancement results |
| `GET /api/district/[district]/advancement/cmp` | District CMP advancement |
| `GET /api/team/[team]` | TBA team record |
| `GET /api/team/[team]/district` | Team district history/current district |
| `GET /api/events/active` | Current-year active/upcoming event summary |
| `GET /api/event/[event]` | TBA event record |
| `GET /api/event/[event]/teams` | TBA event team roster |
| `GET /api/event/[event]/matches` | Canonical TBA event match schedule |
| `GET /api/event/[event]/matches/next` | Derived next match |
| `GET /api/event/[event]/matches/last` | Derived last completed match |
| `GET /api/event/[event]/oprs` | TBA OPR/DPR/CCWM data |
| `GET /api/event/[event]/webcasts` | TBA webcast list |
| `GET /api/event/[event]/teams/statuses` | TBA team event statuses |
| `GET /api/event/[event]/playoffs/alliances` | TBA playoff alliances |
| `GET /api/statbotics/match/[match]` | Statbotics match prediction/record |
| `GET /api/insights/event/[event]` | Assembled event analytics snapshot |
| `GET /api/insights/team/[team]` | Assembled team season history |
| `GET /api/insights/team/[team]/matches` | Derived team match history and review analysis |
| `POST /api/tba/webhook` | Authenticated TBA webhook ingestion/cache mutation |
| `GET /api/remote/ws` | Remote-session WebSocket signaling upgrade |

The TBA proxy-style routes intentionally return upstream-shaped data for internal application use today. They are not yet a versioned public FieldView API. Several of the thin routes have inconsistent validation and failure handling: some only reject an empty event key, some interpolate team/event identifiers without validating their expected shape, and several allow upstream exceptions to escape rather than returning a consistent JSON error envelope. The two insights routes validate their primary identifiers and return controlled JSON errors; the Statbotics match route also validates its key and supports an explicit refresh query.

This is not a recommendation to wrap every TBA response in a new DTO immediately. First define the normalized FieldView contract and decide which endpoints are internal provider adapters versus stable FieldView resources. Then make validation, error shape, freshness metadata, and cache semantics consistent at that boundary.

## Findings

### FV-AUD-001 — Statbotics runtime defaults to a community mirror

**Severity: High / provider-compliance blocker**

`src/lib/statbotics/client.ts` sets `DEFAULT_BASE_URL` to `https://api-statbotics.iterativerefinement.com`. `STATBOTICS_API_BASE_URL` can override it, but the default is not the official API. The team-history response also labels its source as `Statbotics mirror + The Blue Alliance`.

This conflicts with the project requirement to use the official Statbotics API or a FieldView-operated fork, not a community mirror. The generated type schema being sourced from the official OpenAPI document does not change the runtime data host.

**Action:** change the runtime default to the official API or a FieldView-operated endpoint, then validate endpoint compatibility, cache behavior, and the deployed environment configuration.

### FV-AUD-002 — Current-season team history can remain stale for a year

**Severity: High / data-freshness defect**

`src/app/api/insights/team/[team]/route.ts` stores the assembled team-history response under `cache:insights:team-history:<team>:<year>` with a 365-day TTL. The route has no `refresh=1` handling. This applies to the current season as well as completed seasons, even though the underlying Statbotics team-event cache has a much shorter freshness policy.

**Action:** use a current-season TTL appropriate to changing competition data, preserve longer retention only for completed seasons where justified, and provide an explicit refresh/invalidation path.

### FV-AUD-003 — Event Analytics runtime is documented incorrectly

**Severity: High / architecture and operational mismatch**

The documentation says Vercel `waitUntil` advances bounded event-analytics batches and the browser polls collection progress. The inspected route instead awaits both analytics advancement functions before returning, and the dashboard loads on mount or explicit user refresh. There is no `waitUntil` call in the route and no dashboard polling loop.

The season cohort does have a bounded work budget, but the event Statbotics collection is fetched as event-filtered qualification/elimination collections inside the awaited request.

**Action:** document the current synchronous request lifecycle accurately. Separately decide whether to implement background execution and polling, or retain the synchronous route with appropriate execution limits and user-facing loading behavior.

### FV-AUD-004 — WebSocket updates forward full webhook data

**Severity: Medium / transport efficiency and contract clarity**

The webhook handler passes the full `messageData` object to `broadcastTBAEvent`, and the WebSocket bridge forwards it to clients. This can include the full match object. EventState primarily uses the message type and a small subset of fields such as `match_key` and `team_keys`; most update types are invalidation signals.

**Action:** define a minimal, typed invalidation message for the client transport and keep authoritative match data in the Redis/API path.

### FV-AUD-005 — EventAnalytics TBA source status is too coarse

**Severity: Medium / data-quality metadata**

The initial TBA acquisition tolerates failed rankings and playoff-alliance requests by converting them to `null`. The EventAnalytics envelope then reports the grouped TBA source as `ready` whenever the initial job has a TBA timestamp. Consumers cannot distinguish a complete TBA snapshot from one missing those optional inputs.

**Action:** track freshness and availability per TBA resource (or at least expose partial status and missing-resource metadata) rather than treating all TBA inputs as one indivisible source.

### FV-AUD-006 — EventAnalytics v1 is an envelope, not yet a normalized public DTO

**Severity: Medium / contract evolution**

The current type extends the existing `EventAnalyticsResponse` for compatibility. That response retains provider-shaped records. The provenance and schema-version envelope is a useful first step, but provider-independent FieldView-owned DTOs and runtime contract validation are not yet implemented.

**Action:** preserve the compatibility bridge for now; define and validate stable FieldView-owned DTOs before external API consumers or additional client surfaces depend on them.

### FV-AUD-007 — TBA cold-cache requests are not coalesced

**Severity: Medium / acquisition efficiency**

The TBA client has a concurrent-write guard, but no in-flight request map or distributed request lock for a cache miss. Concurrent callers can therefore issue duplicate TBA requests for the same uncached endpoint.

**Action:** measure whether this creates meaningful upstream request amplification, then consider request coalescing without adding another persistent cache layer.

### FV-AUD-008 — Team directory is intentionally incomplete

**Severity: Low / product completeness**

`/teams` displays only the first 200 current-season teams and has no search/filter workflow yet.

**Action:** retain as a known product limitation; prioritize after the core data correctness and freshness issues.

### FV-AUD-009 — Documentation drift obscures current behavior

**Severity: Medium / maintenance risk**

The root README duplicates the homepage section and contains older descriptions of Event Analytics delivery and footer modes. AGENTS.md repeats the homepage section and describes a `waitUntil`/polling workflow that is not present in the current code. Architecture docs also need to distinguish current implementation from target architecture more explicitly.

**Action:** make README a concise project entry point, keep implementation rules in AGENTS.md, and use the architecture/lifecycle documents for detailed current and target behavior.

### FV-AUD-010 — Team match analytics logic is embedded in an API route

**Severity: Medium / service-boundary drift**

`src/app/api/insights/team/[team]/matches/route.ts` is a large route module (approximately 26 KB) containing data acquisition, row construction, residual calculations, elimination-shift analysis, and response assembly. This logic is server-side, but it is coupled to the HTTP handler rather than living behind an application service under `src/lib/insights/`.

**Action:** move calculation/orchestration behind a service boundary when this endpoint is next changed. Keep the route responsible for input validation, invoking the service, and translating results/errors into HTTP responses.

### FV-AUD-011 — Event Analytics dashboard remains monolithic

**Severity: Medium / maintainability**

`src/components/insights/EventAnalyticsDashboard.tsx` is approximately 197 KB and owns the dashboard's data loading, state, tab composition, and substantial presentation logic. This is out of step with the documented goal of independently reusable insight components.

**Action:** do not perform arbitrary extraction during the data-contract audit. Once the EventAnalytics contract and delivery lifecycle are stable, extract coherent reusable insight surfaces and keep the dashboard as composition.

### FV-AUD-012 — Event analytics lock may expire before the route execution limit

**Severity: Medium / concurrency risk to validate**

The event analytics worker lock has a 55-second TTL, while the API route allows up to 60 seconds and awaits the worker. The worker does not renew its lock while it runs. If collection takes longer than the lock TTL, another request could acquire the expired lock before the first invocation has finished.

**Action:** measure actual worst-case execution time and either keep the worker safely below the lock TTL or add ownership-checked lock renewal/heartbeat behavior. Add a concurrency test before changing this mechanism.

### FV-AUD-013 — Team-history provider failure is indistinguishable from missing records

**Severity: Medium / data completeness metadata**

`src/app/api/insights/team/[team]/route.ts` converts a failed `Statbotics.getTeamEvents` request into an empty array. The response then labels individual events without a record as `unavailable`, without exposing whether the collection request failed or Statbotics successfully returned no record for that event.

**Action:** preserve collection-level failure metadata separately from per-event record absence, and expose it in the response so consumers do not mistake a provider outage for missing upstream coverage.

### FV-AUD-014 — Suggested Review recomputes analytical flags in the browser

**Severity: Medium / calculation ownership**

`buildMatchFlagSummary` in `EventAnalyticsDashboard.tsx` derives model upsets, phase-specific median/MAD anomaly bands, event-wide large-residual thresholds, and high-alliance-EPA flags in the client. These are analytical classifications, not merely formatting. The API response already contains some related server-derived diagnostics, but the dashboard independently derives additional flags from the payload.

**Action:** move review classifications and their thresholds into the server-side analytics service, return typed flags/evidence in EventAnalytics, and keep the component responsible for presentation and filtering only.

### FV-AUD-015 — Robust median calculations use the upper middle value for even samples

**Severity: Low / statistical convention**

Both `buildQualificationAnomalies` and the dashboard's `phaseAnomalyBand` sort values and select index `Math.floor(n / 2)`. For an even-sized sample this selects the upper middle observation rather than the conventional median (the mean of the two middle observations). The same convention is used for the MAD.

**Action:** choose and document one median convention, centralize it in a shared server-side helper, and cover odd/even sample sizes with tests before changing historical thresholds.

### FV-AUD-016 — Underdog-win count includes exact 50/50 predictions

**Severity: Low / edge-case label accuracy**

`buildQualificationAnalysis` counts every incorrect predicted winner as an `underdogWin`. The UI describes this as a match won by the side with less than 50% predicted chance. When the model probability is exactly 50%, neither side is an underdog, but the implementation resolves the tie to red and can count a blue win as an underdog win.

**Action:** count an underdog win only when the actual winner's pre-match probability is strictly below 0.5; keep 50/50 outcomes in the overall accuracy sample but outside the underdog count.

### FV-AUD-017 — EventState and EventAnalytics are not yet companion normalized data models

**Severity: Medium / foundational architecture gap**

The current `EventStateSnapshot` directly embeds provider types such as `TBAEvent`, `TBATeam`, `TBAMatch`, TBA rankings/OPRs/alliances, and `StatboticsMatch`. It also mixes the data snapshot with client-runtime state such as loading, errors, WebSocket status, and stale indicators. EventAnalytics v1 wraps the existing `EventAnalyticsResponse`, which also retains provider-shaped records. EventState lives in SharedWorker memory and is rebuilt from the server APIs; it is not a durable server-side model.

Consequently, EventState and EventAnalytics are currently separate acquisition and delivery paths, not two normalized companion models served by one FieldView-owned data layer. Existing `/api/event/*` routes also largely expose TBA-shaped responses.

**Action:** treat the current types as compatibility contracts, not the final model. Define FieldView-owned event, team, match, ranking, result, and analytics DTOs; separate provider response types from normalized data and from client delivery/runtime status. Then make the existing HTTP routes and SharedWorker consume the same application services without forcing a simultaneous client rewrite.

### FV-AUD-018 — TBA cache entries have logical expiry but no Redis TTL

**Severity: Medium / Redis memory lifecycle**

The TBA client stores cache entries with an application-level `expiresAt`, but writes them with plain `redis.set(key, value)` and no Redis expiration. Expired entries remain physically stored until the same key is fetched and overwritten or an explicit tag invalidation deletes them. Tag membership sets are also written without expiration. This preserves stale representations for conditional ETag requests, but means the Redis 30 MB budget is not protected by upstream `max-age` alone.

**Action:** measure key count and memory growth across an active season and offseason. Design bounded stale retention that preserves conditional revalidation where useful; ensure cache data and tag membership have a coherent cleanup lifecycle. Do not simply add a short Redis TTL if that would discard the stale representation needed for ETag/304 handling.

### FV-AUD-019 — Active-events endpoint masks upstream failures as an empty success

**Severity: Medium / API failure semantics**

`GET /api/events/active` catches every failure from TBA acquisition or event-date processing and returns `200 []`. A client cannot distinguish “there are no active/upcoming events” from “TBA or the server-side transformation failed.” This can silently render an empty event list during an outage.

The route also declares a `complete` state but filters out every event whose end date is before the current instant, so that state is unreachable in this endpoint's current result set.

**Action:** return a non-2xx error with a stable JSON error body on failure. Either remove the unreachable state or include completed events if that is part of the endpoint's intended contract.

### FV-AUD-020 — Remote pairing has a short, unthrottled code space

**Severity: High / security review required**

The display creates its six-digit pairing code with `Math.random()` in the browser. The signaling route accepts a code, a caller-selected role, and any non-empty caller-generated UUID token; the server's Redis presence lock prevents a second connection for the same role but does not establish that the caller is the intended peer. There is no visible server-side pairing-code issuance/expiry or attempt-rate limit in the inspected flow. The six-digit code is therefore the effective pairing secret, with only about one million possible values.

The token is placed in the WebSocket URL query string. Query strings are commonly included in infrastructure/request logs, so this unnecessarily exposes a bearer-like connection token to logging surfaces.

**Action:** review the full pairing threat model before public beta. Prefer server-issued cryptographically random, short-lived pairing challenges, enforce per-IP/code attempt limits and expiry, bind role credentials to the issued session, and avoid putting bearer credentials in query strings where the hosting platform supports a safer handshake. Also consider message-size and signaling-rate limits.

### FV-AUD-021 — Thin provider routes lack a consistent validation/error contract

**Severity: Medium / API reliability and future compatibility**

The thin TBA routes return provider-shaped payloads directly, which is acceptable as an internal adapter for now, but input validation and exception behavior vary. For example, `/api/team/[team]` passes the path parameter directly into the TBA service; several event routes only check that the key is non-empty; and multiple routes allow provider errors to escape without a stable JSON error shape. In contrast, the analytics and Statbotics match routes perform stricter identifier validation and translate failures into JSON responses.

**Action:** after the normalized data contract boundary is defined, standardize identifier schemas, error codes/bodies, source freshness/completeness metadata, and cache behavior across FieldView-owned endpoints. Keep raw provider passthroughs explicitly internal until then.

### FV-AUD-022 — A legacy paginated Event Analytics service remains alongside the progressive implementation

**Severity: Low / dead-code and architecture clarity**

`src/lib/insights/service.ts` still exports `getEventAnalytics`, a separate page-at-a-time analytics implementation with its own Redis cache, lock, Statbotics match acquisition, and response assembly. Repository code search found no caller of this exported function outside the file itself. The active event analytics route uses `progressive-service.ts` instead.

This leaves two competing implementations and two different caching/collection models in the same domain. It increases the chance that a future developer updates the unused path or mistakes it for the active service.

**Action:** confirm there are no external/indirect consumers, then remove the unused implementation or clearly archive it. Keep one authoritative EventAnalytics application service and one documented lifecycle.

## Audit verification limits

- `package.json` defines development, lint, build, and type-generation scripts, but no test script.
- No local lint or production build was run during this audit.
- No live TBA, Statbotics, FRC Colors, Redis, Vercel, WebSocket, or remote-session integration was exercised.
- No exhaustive accessibility, mobile layout, statistical-methodology, or security penetration review was performed.

## Recommended next audit passes

1. Resolve the Statbotics runtime provider and team-history freshness defects.
2. Review all analytics calculations against their documented definitions, sample requirements, and edge cases.
3. Audit every API route for validation, response contracts, cache behavior, failure semantics, and source provenance.
4. Audit the main page surfaces and reusable components for data correctness, loading/empty/error states, responsive behavior, and accessibility.
5. Review remote-session ownership, reconnect behavior, and mobile controller/display workflows.
6. Add automated tests around the highest-risk data contracts, calculations, cache reconciliation, and realtime message handling.
