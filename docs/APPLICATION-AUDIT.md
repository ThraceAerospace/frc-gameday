# FieldView application audit

**Audit date:** 2026-11-10  
**Branch:** `ui-cleanup`  
**Audit-start baseline:** `ui-cleanup` was 31 commits ahead of `main` and had no commits behind it. The `main` baseline at audit start was `3c779a754c55eaacd8238fbc7fe83d4dee89530c`. Documentation updates made during this audit are committed on `ui-cleanup`; the branch distance will increase as this audit record is maintained.

## Status and scope

This is the first architecture, data-flow, API, and documentation-consistency pass. It inspects the main application surfaces, the TBA/Statbotics/FRC Colors integrations, Redis caching, webhook/WebSocket delivery, SharedWorker/EventState ownership, Event Analytics orchestration, and the corresponding project documentation.

A second pass has now inspected the core event-analytics calculations, season-cohort comparison, selected-team match analysis, and the dashboard's remaining client-side review logic. It is still not a line-by-line review of every presentation component or every route's accessibility and error states. No local lint, build, automated test, or live-provider validation was run during this pass. Findings below are based on source inspection.

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
2. Continue the analytics methodology review beyond the calculations inspected in this pass; resolve the verified median, underdog, elimination-shift, and anomaly sample-size mismatches.
3. Audit every API route for validation, response contracts, cache behavior, failure semantics, and source provenance.
4. Audit the main page surfaces and reusable components for data correctness, loading/empty/error states, responsive behavior, and accessibility.
5. Review remote-session ownership, reconnect behavior, and mobile controller/display workflows.
6. Add automated tests around the highest-risk data contracts, calculations, cache reconciliation, and realtime message handling.


### FV-AUD-023 — Selected-team anomaly flags use a smaller sample than specified

**Severity: Medium / statistical validity**

The selected-team match endpoint in `src/app/api/insights/team/[team]/matches/route.ts` calculates season-wide team and opponent residual medians/MADs and begins flagging outliers when each side has only four scored observations. The Team Investigation specification requires at least eight scored observations for its robust median/MAD season anomaly bands. With four to seven observations, the current route can produce anomaly labels that the documented methodology says should remain unevaluated.

**Action:** raise the minimum to the documented eight scored observations per side, expose the actual evaluated sample counts beside the flags, and add boundary tests for 7 versus 8 observations.

### FV-AUD-024 — Elimination decline signal does not require positive qualification performance

**Severity: Medium / analytical definition mismatch**

The Team Investigation specification defines the exploratory elimination-decline signal as a qualification-to-elimination residual decline after positive qualification performance. The selected-team match route currently makes an event eligible with at least three scored qualification matches and two scored elimination matches, then calculates the shift as elimination mean residual minus qualification mean residual. It does not require the qualification mean residual to be positive. A team that underperformed expectations in qualifications and declined further in eliminations can therefore contribute to the signal described as a choking/decline pattern.

The route correctly gives each eligible event one shift and uses a one-sided exact sign test, but its eligibility condition is weaker than the documented definition.

**Action:** require positive qualification mean residual for this signal (or rename and separately expose a general phase-decline metric). Test positive, zero, and negative qualification baselines.

### FV-AUD-025 — Event qualification anomaly median/MAD parity differs from the selected-team helper

**Severity: Low / statistical consistency**

`buildQualificationAnomalies` in `src/lib/insights/calculations.ts` selects the upper middle observation for even-sized samples when calculating both the residual median and MAD. The selected-team match route uses the conventional average of the two middle values. The dashboard's `phaseAnomalyBand` has the same upper-middle convention as the event calculation. The same statistical term therefore has different definitions across FieldView views.

**Action:** centralize a tested conventional median/quantile helper in the server-side analytics layer, then migrate consumers deliberately and compare historical results before rollout.

### FV-AUD-026 — Event source status can report ready when optional TBA resources failed

**Severity: Medium / provenance and completeness accuracy**

The EventAnalytics v1 envelope marks the TBA source `ready` whenever `tbaLoadedAt` is set. Initial snapshot creation catches failures for rankings and playoff alliances independently and substitutes `null`; the overall timestamp is still set. A later successful schedule refresh also sets the same timestamp even when the rankings or playoff-alliance refresh failed. Consumers can therefore see `sources.tba.status = ready` without knowing that one or both optional TBA resources are absent or stale.

The current Statbotics status similarly treats the existence of a Statbotics match record as a ready match, without expressing whether the individual prediction, pre-match EPA, and post-match EPA fields needed by particular calculations are present.

**Action:** track freshness/status per independently acquired resource (event, teams, matches, OPRs, rankings, playoff alliances, Statbotics match predictions/EPAs, colors). Distinguish request success from field-level analytical coverage; do not infer complete source coverage from a single aggregate timestamp.

### FV-AUD-027 — Peer comparison excludes the selected team's direct opponents

**Severity: Low / comparison-population decision**

The Team Investigation peer comparison in `buildTeamInsights` compares selected-team qualification alliances with strength-matched qualification alliances elsewhere in the event, but excludes every alliance from the same match as the selected alliance. The written specification says to compare against other same-event alliances in the ±20% pre-match combined-EPA band and does not document this same-match exclusion. This changes the peer population and can reduce coverage, particularly at smaller events.

**Action:** decide and document whether direct opponents should be included. If excluded to avoid dependence between two results from the same match, state that explicitly and expose the exclusion in the sample definition; otherwise include eligible opposing alliances and deduplicate them as currently done for other peer results.


### FV-AUD-028 — Redis Pub/Sub subscriber initialization has no retry path

**Severity: Medium / realtime availability**

`src/lib/realtime/websocket.ts` sets the process-level `subscriberStarted` flag to `true` before awaiting `subscriber.subscribe(TBA_WEBSOCKET_CHANNEL)`. If the initial Redis subscription rejects or fails, the flag remains true. Subsequent WebSocket connections skip initialization, and this process does not attempt to establish another Redis subscriber. The current call site also invokes `ensureSubscriber()` without handling its rejected promise.

This can leave WebSocket clients connected but unable to receive TBA invalidations for the lifetime of that server process after a transient startup/subscription failure. The browser's periodic reconciliation is a fallback, but it does not restore push delivery.

**Action:** make subscriber initialization stateful (idle/connecting/ready), reset it on failure, handle rejected initialization, and retry with bounded backoff. Add a test for an initial subscribe failure followed by successful recovery.

### FV-AUD-029 — EventState exposes no per-resource freshness or failure state

**Severity: Medium / live-data observability**

`EventStateSnapshot` has a global `loading`, one `error` field used by event metadata, and a global `websocketStale` flag. Matches, team statuses, playoff alliances, and OPR requests log failures but retain their previous values without recording resource-specific error, last-success time, or stale status. A subsequent WebSocket message clears the global stale flag even though it only triggers selected resource refreshes and does not prove that every resource is current.

As a result, a consumer cannot distinguish a current resource from an old retained snapshot after a failed refresh, and the global stale indicator can be cleared without successful reconciliation of all event data.

**Action:** add resource-level acquisition metadata to the runtime delivery envelope (status, last successful update, last attempt, error, and stale state). Clear staleness only for a resource after its own successful reconciliation. Keep this runtime metadata separate from the normalized event data contract.


### FV-AUD-030 — Event and team pages fail as a unit when optional data requests fail

**Severity: Medium / page-level data availability**

The event detail page loads event metadata, roster, and matches together, then also awaits playoff alliances when the Matches tab is selected. Any one of those requests—including the playoff-alliance request, which is supplementary to the core event page—causes the entire page to render “Event unavailable.”

The team detail page has a wider failure domain. It first requires both team metadata and district history, then requires team events and avatar, and for every event uses one `Promise.all` across event metadata, team matches, team status, awards, advancement points, and rankings. A failure from one event or one supplementary resource rejects the outer `Promise.all` and prevents the entire team page from rendering, even if the team's core identity and most match history are available. The district detail page has the same all-or-nothing pattern: its team roster, event list, and rankings are loaded in one `Promise.all`, so a rankings failure can prevent the district's teams and events from rendering.

**Action:** define required versus optional resources per page. Keep core event/team identity and match history available when supplementary resources fail; render unavailable sections with source-specific error/freshness metadata. Avoid silently substituting empty arrays for failed resources, because “no records” and “provider unavailable” must remain distinct.


### FV-AUD-031 — District detail routes cannot serve districts added after build

**Severity: Low / season lifecycle and route availability**

`src/app/district/[district]/page.tsx` sets `dynamicParams = false` and generates its static parameter list from the current year's TBA districts at build time. The district directory at `/districts` is dynamically rendered and reads the current year's list at request time. If TBA adds a district after deployment, or the season changes before a new build, the directory can link to a district detail route that Next.js will reject because its parameter was not in the build-time list.

**Action:** either permit dynamic district parameters and retain the one-hour revalidation policy, or ensure district-list changes/new-season transitions trigger a deployment. Add a route-level check that directory links resolve for all currently returned districts.


### FV-AUD-032 — Remote signaling setup failures leak presence reservations

**Severity: Medium / remote-session availability**

`registerRemoteWebSocket` in `src/lib/remote/signalingServer.ts` acquires the role's Redis presence key before creating and subscribing its Pub/Sub client. The asynchronous `start()` call is launched with `void start()`, and failures from `redis.set`, `subscriber.subscribe`, or later setup steps have no encompassing catch/finally cleanup. In particular, a subscription failure after the presence key is acquired can leave the WebSocket open and the role reservation in Redis until its 120-second TTL expires. The normal close/error cleanup handlers are installed only after subscription succeeds.

**Action:** install socket cleanup handlers before fallible setup, wrap initialization in try/catch/finally, release only the matching token-owned presence key on every failure, close the socket on setup failure, and test failures at each setup boundary.

### FV-AUD-033 — Remote data-channel messages are trusted after JSON parsing only

**Severity: Medium / remote protocol integrity**

`RemotePeer.attachChannel` parses incoming data-channel payloads with `JSON.parse` and casts the result to `RemoteSessionMessage`; it does not validate the discriminant or payload shape at runtime. The action path passes the resulting object to `applyRemoteSessionAction`, which dispatches directly to controller methods. Snapshot messages are likewise accepted and applied to the display controller without schema/version or structural validation. TypeScript types protect compile-time callers, not messages received from another browser.

The pairing flow is the trust boundary for these messages, and the current pairing design is separately tracked in FV-AUD-020. A malformed or incompatible peer message can therefore reach state mutation or rendering code.

**Action:** define versioned runtime schemas for remote messages, actions, and snapshots; reject oversized and invalid payloads before dispatch; handle protocol-version mismatch explicitly; and test malformed, unknown, and old-version messages.


### FV-AUD-034 — Homepage hides match-schedule failures as “no completed matches”

**Severity: Low / data availability presentation**

The homepage snapshot catches each event's match-schedule failure and returns `lastMatch: null` and `nextMatch: null`. `HomeEventCard` renders a null last match as “No completed matches yet.” A TBA outage, cache failure, or malformed schedule is therefore presented as a factual absence of completed matches. The card has no way to distinguish an event that has not started from one whose match data could not be loaded.

**Action:** retain per-event match-source status/error/freshness in the homepage snapshot and render an unavailable/stale state separately from an empty schedule. Keep the event card itself available when match data fails.


### FV-AUD-035 — TBA schedule reconciliation re-adds every cached match omitted upstream

**Severity: Medium / canonical schedule correctness**

`reconcileMatchData` in `src/lib/tba/client.ts` merges incoming match arrays with cached arrays. It correctly protects a cached completed result when an incoming representation of the same match has no result, but it also appends every cached match whose key is absent from the incoming array, regardless of whether the match is completed, scheduled, canceled, or otherwise stale.

This means a successful upstream schedule response cannot remove a match that was previously cached. If TBA removes or corrects a schedule entry, FieldView can continue serving that obsolete match indefinitely through subsequent refreshes. The protection for completed match results is broader than necessary and conflates preserving result data with preserving deleted schedule records.

**Action:** define explicit reconciliation rules for same-key result regression versus absent-key deletion. Preserve completed result fields only when the match remains in the canonical schedule; remove absent matches unless a documented provider-consistency exception applies. Add tests for completed-match regression, scheduled-match deletion, completed-match deletion, and normal schedule additions.

### FV-AUD-036 — One district advancement failure aborts the all-district CMP result

**Severity: Medium / cross-district data availability**

`TBA.getAllDistrictTeamsAdvancedToCMP(year)` fetches every district's advancement response concurrently with `Promise.all`. If any one district request rejects, the entire operation rejects and `GET /api/district/all/cmp` cannot return teams from the districts whose responses succeeded. The route has no per-district failure representation or partial-result behavior.

This makes a cross-district summary depend on every district endpoint being available at once. A transient provider/cache failure for one district can hide all otherwise successfully acquired advancement data.

**Action:** acquire district advancement responses with per-district outcomes (for example, `Promise.allSettled`), preserve successful district results, and expose which districts failed plus the overall completeness state. Do not represent a failed district as having zero qualifying teams. Add tests for all-success, one-failure, and all-failure cases.

### FV-AUD-037 — Event OPR acquisition is a hard dependency for the analytics snapshot

**Severity: Medium / analytics data availability**

The initial `getEventAnalyticsSnapshot` acquisition uses one `Promise.all` for event metadata, team roster, match schedule, OPRs, rankings, and playoff alliances. Rankings and playoff alliances are individually caught and downgraded to `null`, but `TBA.getEventOPRs(eventKey)` is not. A rejected OPR request therefore aborts snapshot initialization even though OPR/DPR/CCWM are supplementary comparison metrics and the other event analytics calculations can run without them.

The explicit-refresh path has the same dependency: `latestOprs` is fetched in the schedule-refresh `Promise.all` without an independent failure outcome. An OPR failure prevents the refreshed schedule and rankings from being applied in that block.

**Action:** model OPR acquisition as an independently tracked optional resource. Preserve existing OPR values on refresh failure, record its status/error/freshness separately, and continue building analytics from available event, match, Statbotics, ranking, and alliance data. Do not label missing OPR data as zero or as a successful empty response.

### FV-AUD-038 — Event team EPA has no per-team observation freshness

**Severity: Medium / metric interpretation**

`buildTeamRows` walks the event's analytics match records and increments `matchesSeen` for every team appearance, regardless of whether that match has a usable Statbotics record. The team's displayed EPA is separately carried forward from the latest record with an available post-match EPA, falling back to pre-match EPA and then to the previous value.

Consequently, a team row can show a large `matchesSeen` count alongside an EPA value last observed several matches earlier. The EventAnalytics source status is event-wide, so it does not identify which team's EPA was last updated from which match. Consumers cannot distinguish a current team estimate from a retained older estimate.

**Action:** attach per-team EPA observation metadata (source match, observed phase, and timestamp/order) and expose the number of usable EPA observations separately from total match appearances. Mark carried-forward values as stale/last-known rather than presenting them as equally current.

### FV-AUD-039 — Homepage event-week membership uses the server timezone

**Severity: Low / date-boundary consistency**

The homepage determines which events belong in “This week” with `getCalendarWeekEvents`. It constructs Sunday-to-Saturday boundaries from `new Date()` using the server's local timezone, then parses TBA's date-only event dates with `parseLocalDate`, which also uses the server's local timezone. The same page correctly uses each event's IANA timezone when sorting events as upcoming, in progress, or completed, and the event cards use the event timezone for competition status.

On a server whose timezone differs from an event's timezone, an event near the Sunday/Monday boundary can be included in or excluded from “This week” according to the server's calendar rather than the event's calendar. This is inconsistent with the project rule that event dates and times are interpreted in the event's timezone.

**Action:** calculate the current calendar date and week membership in each event's IANA timezone (with a documented fallback for missing/invalid zones), or explicitly define “This week” as a single reference timezone and use that same rule consistently for filtering and display.

### FV-AUD-040 — Remote EventState snapshots do not preserve Error details

**Severity: Low / remote diagnostics and contract correctness**

`EventStateSnapshot.error` is typed as `Error | null`. The remote controller sends the complete snapshot through `RemotePeer.sendMessage`, which serializes messages with `JSON.stringify`; the display parses that JSON and treats the result as an `EventStateSnapshot`. Native JavaScript `Error` properties such as `message` and `stack` are non-enumerable by default, so an actual Error normally serializes as an empty object. The remote display can still see a truthy error value, but it cannot recover the message or other diagnostic context.

This also means the TypeScript snapshot type does not accurately describe the wire representation for this field.

**Action:** define an explicit serializable event-state wire DTO and normalize errors to structured data (at minimum `name` and `message`, with stack omitted or restricted as appropriate). Validate and reconstruct presentation state at the receiving boundary rather than asserting parsed JSON is already an `EventStateSnapshot`.

### FV-AUD-041 — “Last played match” and “has result” use different TBA signals

**Severity: Medium / live match selection and result visibility**

The canonical match cache's `hasMatchResult` recognizes a result when `actual_time`, `post_result_time`, `score_breakdown`, or either alliance's nonnegative score is present. `getNextMatch` likewise considers a match no longer upcoming when either alliance score is not `-1`.

However, `matchUtils.isPlayed` and the separate `isMatchPlayed` helper in `src/lib/tba/service.ts` use only `actual_time != null`. The `getLastMatch` helper in `src/lib/tba/matchUtils.ts`, which EventState imports, depends on `isPlayed`; the separate `TBA.getLastMatch` implementation in `src/lib/tba/service.ts` instead selects by posted scores. The two last-match paths therefore disagree, and the EventState path can exclude a match with posted scores but no `actual_time`. The actual-time-only helper also affects `getActiveEventsWithMatches`, which can omit an event whose match scores are posted before `actual_time` is populated.

In EventState this can leave `eventLastMatch` behind the latest result and consequently select the wrong match for the live Statbotics warm-cache behavior. Other consumers of the service helper can similarly misclassify a scored match.

**Action:** define one canonical match-result predicate and use it consistently for cache reconciliation, next/last match selection, and service helpers. Keep “result posted” distinct from “match physically played at a known timestamp” if both concepts are needed; do not make the latter the sole criterion for whether a result exists. Add fixtures where scores, `post_result_time`, or `score_breakdown` exist while `actual_time` is null.

### FV-AUD-042 — Team match schedule treats negative EPA as missing data

**Severity: Low / metric fidelity**

In the Team Investigation match schedule inside `EventAnalyticsDashboard.tsx`, alliance member pre-match EPA is retained only when it is finite and `>= 0`; negative values are converted to `null`. The same dashboard then withholds the alliance EPA total unless every team has a retained value. The shared `buildTeamRows` calculation in `src/lib/insights/calculations.ts` also excludes any alliance containing a negative pre-match EPA from `epaContributionPercent` samples, even though the underlying EPA value is retained in the team row. Other consumers, such as `EventInsightView.sumAvailableValues` and `buildAllianceResults`, accept any finite numeric EPA value, including negative values.

EPA is a centered contribution estimate and can legitimately be negative for teams below the model's reference level. Treating negative EPA as unavailable suppresses valid source data, can make alliance totals disappear, and silently reduces the contribution-share sample to only all-nonnegative alliances. Contribution share may need a positive-total constraint, but that is distinct from treating negative individual estimates as missing.

**Action:** validate EPA by numeric finiteness, not nonnegativity. Keep negative values in the displayed team estimate and alliance sum. If an EPA-share visualization requires a positive denominator or has a different mathematical interpretation, handle that constraint explicitly and document the resulting sample rather than discarding underlying EPA observations.

### FV-AUD-043 — Statbotics win probabilities are range-validated inconsistently

**Severity: Low / prediction diagnostics integrity**

The qualification calibration path in `buildQualificationAnalysis` correctly excludes `red_win_prob` values outside the inclusive `[0, 1]` range. Other consumers do not apply the same domain check:

- `buildQualificationAnomalies` accepts any finite number and can classify an out-of-range value as a high-confidence miss.
- `buildTeamInsights` converts any finite red probability into a team-side probability and can surface misleading review reasons.
- The dashboard's `predictionClassification` checks finiteness but not the probability range; `buildMatchFlagSummary` also derives a favorite and upset from the unbounded value.
- The team-match API similarly converts any finite red win probability into a team-side probability, and accepts any finite RP prediction in its accuracy/Brier calculations without checking the `[0, 1]` domain.

A malformed or unexpected provider value can therefore be excluded from calibration while still appearing as a valid 100%+ prediction or generating anomaly/review flags elsewhere in the same analytics snapshot. Out-of-range RP probabilities can also distort the team-match RP diagnostics.

**Action:** validate probability values once at the provider-normalization boundary (finite and between 0 and 1 inclusive), preserve invalid raw values only as source diagnostics if useful, and have all calculations/UI consumers use the normalized nullable probability. Add shared tests for negative, greater-than-one, NaN, and boundary values.

### FV-AUD-044 — One failed event request aborts the entire team-match history

**Severity: Medium / historical data availability**

The team-match analysis route fetches each team's event schedule through `withConcurrency(events, 4, ...)`. The concurrency helper writes each worker result but does not catch individual failures. If `TBA.getTeamMatches` rejects for any one event, the aggregate `Promise.all` rejects, the route returns a 502, and match data successfully retrieved for every other event is discarded.

This is especially problematic for a season-wide endpoint: a temporary TBA failure for one event makes the team's entire match history unavailable even though other events could still be analyzed. The current payload has no per-event TBA collection status or completeness metadata to distinguish a partial season from a complete one.

**Action:** collect per-event outcomes independently, preserve successful event matches, and include explicit per-event failure status plus aggregate completeness in the response. Keep a fully failed request distinguishable from a successful response with zero matches.

### FV-AUD-045 — Team-match Statbotics collection status can report complete after acquisition failure

**Severity: Medium / source completeness and diagnostics**

The team-match route catches a failed bulk `Statbotics.getMatches` request and substitutes an empty array. It then derives `collection.state` exclusively from whether every completed TBA match row has `statboticsAvailable === true`.

This loses the distinction between a successful Statbotics collection containing no matching records and a failed collection request. With completed TBA matches, a failed request is reported only as generic `partial`, indistinguishable from successful acquisition with some missing per-match Statbotics records. With zero completed TBA matches, `[].every(...)` is true, so the route reports `complete` even when the Statbotics collection request failed.

**Action:** track the bulk Statbotics request outcome separately from per-match record coverage. Expose request status/error/freshness and record coverage as distinct fields. A successful empty collection may be complete with zero records; a failed request must remain unavailable/failed even when there are no completed TBA matches. Add tests for failed request with zero matches, failed request with scored matches, successful empty collection, and successful partial record coverage.

### FV-AUD-046 — Team EPA trend and reported endpoint use different observation rules

**Severity: Low / metric consistency**

In `buildTeamInsights`, the EPA trend includes each appearance's `postEPA ?? preEPA`, so a pre-match EPA observation is retained when that match has no post-match update. The reported `epaEnd`, however, searches backward for a non-null `postEPA` only and returns `null` if no post-match observation exists. The reported `epaChange` is then calculated from the first pre-match observation to that post-only endpoint.

This makes the summary inconsistent with the trend and with `buildTeamRows`, which also carries forward the latest `post_epas` or falls back to `pre_epas`. For a team whose latest available observation is pre-match (or whose event has no completed Statbotics update), the trend can contain a valid latest EPA while the endpoint/change says no value is available.

**Action:** define the intended endpoint as the latest usable observation, preserving its phase and match provenance. If the metric specifically requires a post-match endpoint, label it as such and expose the latest pre-match observation separately rather than silently omitting it. Add cases with only pre-match records and with a final match lacking post-match EPA.

### FV-AUD-047 — Statbotics phase collection is all-or-nothing

**Severity: Medium / partial data loss**

The event analytics worker requests qualification and elimination Statbotics collections together with `Promise.all`. If either request rejects, control enters one shared catch block and the worker marks every TBA match in the event unavailable. Any successful collection from the other phase is discarded rather than retained. For example, an elimination endpoint failure can erase usable qualification predictions from the resulting EventAnalytics snapshot, and vice versa.

This unnecessarily couples two independently useful datasets. It also makes the source status less informative: consumers see a failed event-wide collection rather than usable data for one phase and an acquisition failure for the other.

**Action:** collect qualification and elimination results independently, preserve whichever phase succeeds, and track status/error/freshness per phase. Derive aggregate Statbotics status as partial when one phase is usable and the other is unavailable. Add tests for both-success, qualification-only success, elimination-only success, and both-failure cases.

### FV-AUD-048 — Failed event Statbotics collection is marked loaded and will not retry automatically

**Severity: Medium / recovery and data freshness**

In `advanceEventAnalytics`, `job.statboticsLoadedAt` is assigned after the Statbotics collection try/catch regardless of whether acquisition succeeded. The normal early-return condition then treats that timestamp as completed collection work. Since the API route invokes `advanceEventAnalytics(event)` on subsequent page opens, but the persisted timestamp is already set, those requests do not retry a failed Statbotics collection. The failure remains in the one-year Redis job until a user explicitly requests `refresh=1`, which resets the timestamp and triggers another attempt.

This differs from the FRC Colors failure path in the same worker: on failure, its loaded timestamp remains unset, allowing a later snapshot request to retry it. A transient Statbotics outage can therefore leave an otherwise reusable historical analytics snapshot permanently unavailable to ordinary viewers, with recovery depending on someone knowing to force-refresh it.

**Action:** distinguish attempted-at from successfully collected-at state. Use a bounded retry policy/backoff for failed Statbotics acquisition, while retaining explicit refresh as an override. Do not mark a failed source as successfully loaded merely to suppress repeated requests; expose the next retry eligibility or retry state in source metadata. Add tests proving that a failed attempt can recover on a later eligible request without deleting unrelated successful analytics data.

### FV-AUD-049 — Season-cohort discovery couples TBA and Statbotics into one per-team success

**Severity: Medium / historical comparison coverage**

In `advanceSeasonCohort`, each team's TBA event history and Statbotics team-event collection are fetched together with `Promise.all`. The team is removed from `discoveryQueue` and its event history is processed only when both requests succeed. If either provider request fails, the catch path retries the whole team discovery; after three attempts it removes that team from the queue and records only the team number in `discoveryFailures`.

This couples two distinct acquisition responsibilities. A transient Statbotics failure can discard a successful TBA event-history response, even though that history is useful for establishing which event is the team's latest preceding event. Conversely, a TBA failure prevents processing a successfully acquired Statbotics collection. After the third failure, the cohort retains no per-team error or provider-specific outcome, and that team is not retried during ordinary requests.

**Action:** track TBA event discovery and Statbotics team-event acquisition as separate per-team outcomes. Preserve successful TBA history even when Statbotics is unavailable, and preserve any Statbotics collection that can be used once the corresponding event history is known. Store provider-specific attempt counts, last errors, and retry eligibility; keep exhausted teams visible as incomplete rather than silently dropping their acquisition state. Add tests for TBA-only failure, Statbotics-only failure, recovery on a later request, and terminal/exhausted status.

### FV-AUD-050 — TBA cache does not serve stale data when upstream refresh fails

**Severity: Medium / provider outage resilience and data availability**

The TBA client reads an expired Redis representation and uses its ETag for a conditional request, but the network fetch and non-OK response handling have no stale-on-error fallback. If the upstream request rejects or returns an error status, TBAClient.get throws even though the prior cached representation is still available. Callers therefore receive an acquisition failure during a TBA outage rather than the last-known data with an explicit stale indicator. The Redis cache entry remains available for a later retry, but the current request does not use it.

This differs from the Statbotics client, which returns its cached representation when a refresh fails and records a retry cooldown. For a data application, freshness and availability should be represented separately: a stale schedule or event record may still be more useful than no data, provided consumers can see that it is stale and do not mistake it for current live state.

**Action:** define a deliberate TBA stale-on-error policy. When an expired representation exists, consider returning it with explicit stale/error/fetched-at metadata while preserving the refresh failure for observability. Keep endpoints that require authoritative freshness able to opt out. Do not silently extend the freshness claim or present stale data as live; test network failure, 5xx, no-cache cold failure, and successful recovery.
### FV-AUD-051 — Match webhooks leave standalone match-detail cache stale

**Severity: Medium / cross-surface data consistency**

The TBA webhook handler passes complete match_score and match_video payloads to TBAClient.mutateMatchCaches. Despite its comment describing event/team match caches, that method only mutates `/event/<eventKey>/matches`. The match-detail page at `/event/[event]/match/[match]` independently loads its match through `TBA.getMatch(matchKey)`, which reads the separate `/match/<matchKey>` Redis cache entry. The page does not subscribe to the event WebSocket. Consequently, a webhook can update the event schedule and trigger live EventState reconciliation while the match-detail page continues to receive the old standalone match representation until its own cache expires or is refreshed. The same webhook mutation also leaves team-scoped `/team/<teamKey>/event/<eventKey>/matches` entries untouched; both the team detail page and the team-match analytics route consume those endpoints. Those surfaces can therefore disagree with the updated event schedule as well.

**Action:** make webhook cache mutation cover every canonical cached representation that the application serves for the changed match, including `/match/<matchKey>` and affected team-scoped match endpoints, or invalidate those entries so their next read fetches current data. Ensure mutation/invalidation is safe when an endpoint is not currently cached. Add an integration test proving a score/video webhook makes event, match-detail, team-detail, and team-match-analysis reads observe the updated match.
