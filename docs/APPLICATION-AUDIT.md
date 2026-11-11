# FieldView application audit

**Audit date:** 2026-11-10  
**Branch:** `ui-cleanup`  
**Audit-start baseline:** `ui-cleanup` was 31 commits ahead of `main` and had no commits behind it. The `main` baseline at audit start was `3c779a754c55eaacd8238fbc7fe83d4dee89530c`. Documentation updates made during this audit are committed on `ui-cleanup`; the branch distance will increase as this audit record is maintained.

## Status and scope

The audit has expanded beyond the initial architecture pass into targeted source-level reviews of the main data paths: TBA and Statbotics provider clients, FRC Colors acquisition, Redis cache envelopes and lock lifecycles, webhook mutation and realtime fan-out, SharedWorker/EventState lifecycle and resource reloads, remote WebRTC snapshot delivery, event/team/district API routes, event and team analytics orchestration, season-cohort comparisons, metric calculations, and date/time formatting. The API route inventory and the principal architecture/type/analytics documentation have also been checked against the implementation.

The audit currently contains 95 individually numbered findings (FV-AUD-001 through FV-AUD-095). The findings are implementation observations and recommended follow-ups, not a claim that every issue has been fixed. The review is still in progress: not every presentation component, route edge case, deployment configuration, or browser/runtime behavior has received a line-by-line or live validation pass. No local lint, build, automated test, or live-provider validation has been run during this source-only review. The repository currently has no automated test command or test-runner dependency (FV-AUD-071).

## Executive summary

FieldView already has a meaningful data architecture: TBA acquisition is centralized behind a Redis-backed service; live event state is shared through an origin-wide SharedWorker; analytics calculations are server-side; and the application has distinct event, team, district, Gameday, Insights, and remote-display surfaces.

The largest risks found in this pass are not visual. They concern source correctness, freshness, completeness, and the reliability of the data-delivery path:

1. The Statbotics runtime defaults to a community-operated mirror rather than the project's required official/FieldView-operated source.
2. Current-season team history can remain cached for a year; multiple analytics consumers also hide stale-on-error provider fallbacks behind fresh-looking timestamps/status.
3. Webhook handling does not consistently update or invalidate every cached representation and dependent resource; some failed cache mutations are still acknowledged as successful updates.
4. Redis lock leases can expire during provider/job work, concurrent workers can overwrite progress, and explicit refreshes can silently return the old snapshot when a lock is held.
5. TBA, Statbotics, and FRC Colors payloads are trusted with insufficient runtime validation; malformed data can be cached or converted into false-empty state.
6. EventState has no per-resource loading/freshness/failure contract, while some consumers treat incomplete or malformed responses as empty data.
7. Remote delivery has lifecycle, lease, payload-size, and network-connectivity gaps; the fallback WebSocket can remain open after its last consumer leaves.
8. Several documented data surfaces/behaviors are not implemented as described, and the repository has no automated test harness for the provider/cache/concurrency/analytics paths.

These should be resolved or explicitly accepted with documented freshness/completeness guarantees before treating the data layer as ready for a public beta.

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
- `POST /api/tba/webhook` authenticates `X-TBA-HMAC` before parsing JSON. It attempts to mutate the event-wide match cache for match/upcoming-match notifications, then publishes an event-scoped update through Redis Pub/Sub. This is not yet a complete cache-coherence strategy: standalone/team/simple match representations and dependent statuses/alliances/OPRs are not consistently updated or invalidated, and mutation-write failures can be swallowed before the webhook returns success.
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

- Statbotics requests are centralized through `src/lib/statbotics/client.ts` and `src/lib/statbotics/service.ts`. The client supports ETags, upstream cache headers, a ten-minute minimum request interval, endpoint fallbacks, stale-on-error behavior, and retry backoff. However, stale fallback provenance/freshness is not propagated to consumers, the minimum interval can override a shorter upstream max-age, and successful resource payloads are not runtime-schema-validated.
- The generated Statbotics type document is fetched from the official Statbotics OpenAPI endpoint. This is separate from the runtime data host: the runtime client currently defaults to `https://api-statbotics.iterativerefinement.com`, a community-operated mirror.
- FRC Colors is accessed through `src/lib/frc-colors/` and caches event colors in Redis for 24 hours.

### Event Analytics

- Calculations and orchestration live under `src/lib/insights/`; the dashboard is `src/components/insights/EventAnalyticsDashboard.tsx`.
- `EventAnalytics` v1 adds schema version, event identity, generation time, provenance, and source status to the existing analytics response. It still extends `EventAnalyticsResponse`, so the compatibility payload retains provider-shaped TBA and Statbotics records. It is not yet a provider-independent DTO.
- The event analytics job is stored in Redis with a one-year TTL. A normal open reuses the persisted event snapshot; explicit refresh re-reads the event schedule/OPR/rankings/alliances through the ordinary TBA cache policy (it does not guarantee an upstream TBA refresh) and requests refreshes for Statbotics/FRC Colors. Job-lock contention can also cause an explicit refresh to return the prior snapshot without an in-progress signal.
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

`src/app/api/insights/team/[team]/route.ts` stores the assembled team-history response under `cache:insights:team-history:<team>:<year>` with a 365-day TTL. The route has no `refresh=1` handling. This applies to the current season as well as completed seasons, even though the underlying Statbotics team-event cache has a much shorter freshness policy. The cache key has no response-schema version, and a cache hit is returned after `JSON.parse` without validating the payload shape. A team-history contract change can therefore leave an older response shape in circulation for up to a year, with no explicit refresh path to migrate it; this differs from the team-match analysis route, which uses a versioned `v2` cache key. The only in-repository caller found is the dashboard's unfinished two-team history effect, which is currently unreachable because `setTeamB` is never called (FV-AUD-093). These cache risks are therefore latent for direct API consumers or a future implementation of that comparison surface, rather than an active request path in the current UI.

**Action:** use a current-season TTL appropriate to changing competition data, preserve longer retention only for completed seasons where justified, provide an explicit refresh/invalidation path, and version/validate the cached response contract so deployments cannot silently serve incompatible historical payload shapes.

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

The root README duplicates the homepage section and contains older descriptions of Event Analytics delivery and footer modes. AGENTS.md repeats the homepage section and describes a `waitUntil`/polling workflow that is not present in the current code. Architecture docs also need to distinguish current implementation from target architecture more explicitly. AGENTS.md also names stale implementation paths/components: it points to `src/lib/gameday/matchUtils.ts` although the live canonical helpers are in `src/lib/tba/matchUtils.ts`, and describes `MultiviewView` ownership while the current surface implementation is `TileView`/`TileSurfaceController` under `src/components/surface`. The missing `EventDataPanel` and `dataPanel` tile support is tracked separately in FV-AUD-076.

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

`src/app/api/insights/team/[team]/route.ts` converts a failed `Statbotics.getTeamEvents` request into an empty array. The response then labels individual events without a record as `unavailable`, without exposing whether the collection request failed or Statbotics successfully returned no record for that event. The endpoint's only in-repository caller is the unfinished dual-team history effect, which is currently unreachable because `setTeamB` is never called (FV-AUD-093); this is a latent API contract issue rather than a currently exercised dashboard path.

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

`GET /api/events/active` catches every failure from TBA acquisition or event-date processing and returns `200 []`. A client cannot distinguish “there are no active/upcoming events” from “TBA or the server-side transformation failed.” This can silently render an empty event list during an outage. The transformation is also all-or-nothing: it constructs an `Intl.DateTimeFormat` for each event's timezone inside a single array `map`. One malformed date or invalid IANA timezone throws out of the whole map, causing the catch to discard every otherwise valid event and return an empty list.

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

`src/lib/realtime/websocket.ts` sets the process-level `subscriberStarted` flag to `true` before awaiting `subscriber.subscribe(TBA_WEBSOCKET_CHANNEL)`. If the initial Redis subscription rejects or fails, the flag remains true. Subsequent WebSocket connections skip initialization, and this process does not attempt to establish another Redis subscriber. The current call site also invokes `ensureSubscriber()` without handling its rejected promise. In addition, the message handler is registered only after `await subscriber.subscribe(...)` resolves. A webhook publication arriving after Redis has acknowledged the subscription but before the `message` listener is attached can be delivered into the gap and dropped, even when initialization otherwise succeeds.

This can leave WebSocket clients connected but unable to receive TBA invalidations for the lifetime of that server process after a transient startup/subscription failure. The browser's periodic reconciliation is a fallback, but it does not restore push delivery.

**Action:** make subscriber initialization stateful (idle/connecting/ready), reset it on failure, handle rejected initialization, and retry with bounded backoff. Attach the message handler before awaiting subscription so no publication can fall between the subscribe acknowledgement and listener registration. Add tests for initial subscribe failure/recovery and a publication delivered immediately after subscription acknowledgement.

### FV-AUD-029 — EventState exposes no per-resource freshness or failure state

**Severity: Medium / live-data observability**

`EventStateSnapshot` has a global `loading`, one `error` field used by event metadata, and a global `websocketStale` flag. Matches, team statuses, playoff alliances, and OPR requests log failures but retain their previous values without recording resource-specific error, last-success time, or stale status. A subsequent WebSocket message clears the global stale flag even though it only triggers selected resource refreshes and does not prove that every resource is current.

As a result, a consumer cannot distinguish a current resource from an old retained snapshot after a failed refresh, and the global stale indicator can be cleared without successful reconciliation of all event data. The single `loading` flag is also driven by `loadEvent()` alone: it becomes false as soon as event metadata returns, even while teams, matches, statuses, alliances, and OPRs are still loading. Consumers can therefore render a successful event page with empty schedule/team sections before those resources have completed, but have no per-resource pending state to distinguish that transient condition from a genuinely empty result.

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

`registerRemoteWebSocket` in `src/lib/remote/signalingServer.ts` acquires the role's Redis presence key before creating and subscribing its Pub/Sub client. The asynchronous `start()` call is launched with `void start()`, and failures from `redis.set`, `subscriber.subscribe`, or later setup steps have no encompassing catch/finally cleanup. In particular, a subscription failure after the presence key is acquired can leave the WebSocket open and the role reservation in Redis until its 120-second TTL expires. The normal close/error cleanup handlers are installed only after subscription succeeds. A client that disconnects while `start()` is awaiting the Redis presence write or Pub/Sub subscription can also emit its close event before the handler is attached; the later listener registration does not replay that event. The code can then finish initialization with a live presence-refresh interval and subscriber attached to an already-closed socket, renewing the reservation indefinitely. Because `void start()` has no rejection handler, setup errors can also become unhandled promise rejections.

**Action:** install socket cleanup handlers before fallible setup, wrap initialization in try/catch/finally, release only the matching token-owned presence key on every failure, close the socket on setup failure, and test failures at each setup boundary.

### FV-AUD-033 — Remote data-channel messages are trusted after JSON parsing only

**Severity: Medium / remote protocol integrity**

`RemotePeer.attachChannel` parses incoming data-channel payloads with `JSON.parse` and casts the result to `RemoteSessionMessage`; it does not validate the discriminant or payload shape at runtime. The action path passes the resulting object to `applyRemoteSessionAction`, which dispatches directly to controller methods. Snapshot messages are likewise accepted and applied to the display controller without schema/version or structural validation. TypeScript types protect compile-time callers, not messages received from another browser.

The pairing flow is the trust boundary for these messages, and the current pairing design is separately tracked in FV-AUD-020. A malformed or incompatible peer message can therefore reach state mutation or rendering code.

**Action:** define versioned runtime schemas for remote messages, actions, and snapshots; reject oversized and invalid payloads before dispatch; handle protocol-version mismatch explicitly; and test malformed, unknown, and old-version messages.


### FV-AUD-034 — Homepage hides match-schedule failures as “no completed matches”

**Severity: Low / data availability presentation**

The homepage snapshot catches each event's match-schedule failure and returns `lastMatch: null` and `nextMatch: null`. `HomeEventCard` renders a null last match as “No completed matches yet.” A TBA outage, cache failure, or malformed schedule is therefore presented as a factual absence of completed matches. The card has no way to distinguish an event that has not started from one whose match data could not be loaded. Because this per-event failure result is returned as part of the `unstable_cache`-wrapped homepage snapshot, the false-empty state can also be retained for the one-hour revalidation interval after the provider/cache failure has recovered.

**Action:** retain per-event match-source status/error/freshness in the homepage snapshot and render an unavailable/stale state separately from an empty schedule. Keep the event card itself available when match data fails.


### FV-AUD-035 — TBA schedule reconciliation re-adds every cached match omitted upstream

**Severity: Medium / canonical schedule correctness**

`reconcileMatchData` in `src/lib/tba/client.ts` merges incoming match arrays with cached arrays. It correctly protects a cached completed result when an incoming representation of the same match has no result, but it also appends every cached match whose key is absent from the incoming array, regardless of whether the match is completed, scheduled, canceled, or otherwise stale.

This means a successful upstream schedule response cannot remove a match that was previously cached. If TBA removes or corrects a schedule entry, FieldView can continue serving that obsolete match indefinitely through subsequent refreshes. The protection for completed match results is broader than necessary and conflates preserving result data with preserving deleted schedule records. The Event Analytics refresh path adds a second copy of the same retention behavior: `advanceEventAnalytics` merges the refreshed schedule into the persisted `job.matches` map and writes back every prior match not otherwise replaced; it never removes keys absent from the refreshed schedule. Fixing only the low-level TBA cache merge would therefore still leave deleted/canceled matches in persisted Event Analytics snapshots until the job is rebuilt or corrected.

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


### FV-AUD-052 — TBA cache writes are vulnerable to webhook/refresh races

**Severity: Medium / live data consistency**

The TBA client attempts to protect webhook updates from overlapping upstream refreshes by re-reading the cache immediately before writing a fetched response. If the Redis value differs from the value read before the fetch, it returns the newer cached value instead of overwriting it. However, this is a non-atomic read-then-write check: a webhook can mutate the cache after that final read and before the refresh's `redis.set`, allowing the older upstream response to overwrite the newer webhook data. The protection therefore narrows the race window but does not close it.

Webhook mutations have the same read-modify-write problem. `mutateCached` reads and parses an entry, applies a mutation in application code, then unconditionally writes the result. Two concurrent webhook mutations to the same cache key can both read the same starting value and then overwrite one another, losing whichever mutation writes first. For example, an `upcoming_match` timing update and a `match_score` update can overlap. The conditional-request `304 Not Modified` path is also unprotected: it writes an expiry-renewed copy of the pre-fetch `cached` object without re-reading Redis, so a webhook mutation during the request can be overwritten even without reaching the `200` response path.

These races can produce a cache representation older or less complete than the latest webhook state, even though each individual request completed successfully and the webhook handler broadcasts after its mutation call.

**Action:** make cache updates concurrency-safe. Use an atomic Redis operation (such as a Lua script or compare-and-set/version check) to apply webhook mutations and to prevent an upstream refresh from replacing a cache entry changed since the refresh began. If the chosen Redis provider cannot support the needed atomic primitive, use a version/fencing strategy with a clearly defined retry path. Add deterministic concurrency tests for refresh-versus-webhook and webhook-versus-webhook interleavings, asserting that independent newer fields are not lost.


### FV-AUD-053 — Webhook cache updates do not defer upstream refresh for the documented reconciliation window

**Severity: Medium / live schedule consistency**

The live-runtime documentation specifies that webhook-mutated match caches remain available while their TBA refresh deadline is deferred for 65 seconds, allowing upstream TBA to catch up before authoritative reconciliation. The implementation does not apply that cache policy. `TBAClient.mutateCached` preserves the existing `expiresAt` unchanged when it writes webhook-mutated data. `EventState.handleWebSocketMessage` immediately calls `reloadMatches(true)` for match-score, upcoming-match, and match-video notifications, so the subsequent API request can enter `TBAClient.get` and fetch upstream immediately whenever the pre-existing Redis entry is already expired. The 65-second EventState timer schedules a later reconciliation, but it does not prevent this immediate cache-layer refresh.

This is particularly risky for `upcoming_match`: `reconcileMatch` preserves cached data only when it contains a posted result and the incoming match does not. A stale upstream match response can therefore replace webhook-updated scheduled/predicted times or team assignments before the documented catch-up window has elapsed. The result-preservation rule does not protect these schedule-only changes.

**Action:** implement the documented webhook freshness policy in the cache layer, not only in EventState's timer. A webhook mutation should establish an explicit short refresh deadline (or equivalent authoritative-refresh-not-before metadata), and ordinary reads during that window should serve the webhook-updated representation without prematurely accepting an older upstream response. Preserve a deliberate force-refresh path and distinguish this temporary freshness hold from a claim that upstream data is authoritative. Add tests for an already-expired cache followed by an upcoming-match webhook, immediate EventState reload, an outdated upstream response, and successful reconciliation after the 65-second window.


### FV-AUD-054 — Match-score webhooks do not clear the upcoming-match marker

**Severity: Medium / live alert correctness**

The TBA webhook route broadcasts the original `message_data` object as `messageData`. For `match_score`, the webhook data type and handler use the complete match object at `message_data.match`; the match identifier is therefore `message_data.match.key`. In `EventState.handleWebSocketMessage`, however, the `match_score` handler attempts to read `message.messageData.match_key`. That field is not populated by the current webhook payload, so `matchKey` is null and the code does not clear `upcomingMatchKey` or `upcomingMatchTeamKeys`.

The handler does reload the match schedule, but the upcoming marker is independent of the schedule-derived `eventNextMatch`. Consumers use the marker and its team list to drive tracked-team notifications and visual alerts: `useUpcomingMatchAlert`, TileView's upcoming-match banner source, and the remote event card. A scored match can consequently remain flagged as upcoming, and a tracked-team alert can persist after the match has finished.

**Action:** normalize the webhook payload at the server boundary so every match-score notification includes a canonical `match_key`, or have EventState read the nested `match.key` shape with runtime validation. Clear the marker only when the completed match key matches the current upcoming key. Add a webhook-to-EventState integration test asserting that a match-score notification clears the marker and tracked-team alert for that match.


### FV-AUD-055 — Upcoming-match webhooks update only the event-wide full-match cache

**Severity: Medium / schedule consistency across team views**

The `upcoming_match` webhook is handled separately from full-match notifications. `TBAClient.mutateUpcomingMatch` patches only `/event/<eventKey>/matches`. It does not update the team-scoped `/team/<teamKey>/event/<eventKey>/matches` representations, which are independently cached and consumed by the team detail page and the season-wide team-match analysis route. It also does not update the event's `/matches/simple` representation, which is separately used by active-event discovery and active-event enrichment.

The webhook's flat `team_keys` list is copied into a top-level `team_keys` property on the cached match object; it is not mapped into `alliances.red.team_keys` or `alliances.blue.team_keys`, which are the fields consumed by match/team presentation and tracked-team derivation. EventState separately retains the webhook list in `upcomingMatchTeamKeys` for notification filtering, but the TileView banner source resolves the match's tracked teams from the cached match alliance arrays. If the webhook announces a changed or not-yet-reconciled team assignment, the notification marker can identify a tracked team while the banner resolves the old alliance membership or clears the alert. Meanwhile team-scoped and simple schedule consumers continue to read their previous cached representations.

**Action:** propagate the upcoming-match patch to every affected canonical schedule representation, including team-scoped and simple match caches, or invalidate those representations for refetch. Handle team membership changes by invalidating both old and new team-scoped caches when the affected team set is known; do not assume a map-only update can add a match to a team's schedule. Add tests covering timing-only updates and team-assignment changes across event, team, and simple schedule reads.


### FV-AUD-056 — Statbotics force-refresh can silently return the pre-refresh cache

**Severity: Medium / refresh correctness and operator expectations**

The Statbotics client accepts `refresh: true` to bypass the normal freshness and minimum-request-interval checks. However, if acquiring the per-resource Redis lock fails, `getCached` immediately returns the previously cached data whenever a cache entry exists. This branch does not distinguish an ordinary request from a force-refresh request and does not wait for the lock holder to publish a newer representation. The `waitForCache` path is used only when there is no cached entry.

Consequently, a request explicitly made with `refresh=1` can return successfully with the old cached data while another request is still refreshing that resource. The caller receives no indication that its force-refresh request did not itself complete or observe the in-flight refresh. This behavior is reachable through the per-match Statbotics API and the bulk match/team-event collection refreshes used by Event Analytics and team-match analysis.

**Action:** define force-refresh concurrency semantics explicitly. When a refresh is already in progress, either wait for a cache generation newer than the one observed at request start (bounded by the route's execution budget), join/share the in-flight result, or return an explicit refresh-in-progress outcome rather than silently presenting the old cache as refreshed. Keep ordinary stale-while-refresh reads fast. Add concurrent tests for normal-versus-force, force-versus-force, and lock timeout cases.


### FV-AUD-057 — Statbotics request lock can expire while its provider fetch is still running

**Severity: Medium / duplicate acquisition and cache ordering**

The Statbotics client acquires a per-resource Redis lock with a fixed 20-second expiry, but the upstream `fetch` has no request timeout and the lock is not renewed while the request is in progress. If a provider request takes longer than 20 seconds, the lock can expire before its owner finishes. A second caller can then acquire the same lock and start another request for the same resource.

Both callers write their results without a generation/fencing check at commit time. If the second request completes first and the original request completes later, the older request can overwrite the newer cache entry. The token-checked `releaseLock` prevents the first caller from deleting a newer owner's lock, but it does not prevent the first caller from writing after its lease has expired.

**Action:** make the lock lifetime and request lifetime consistent. Apply a bounded provider timeout shorter than the lease, renew the lease while work is active, or use a fencing/generation token checked atomically when committing cache results. Ensure a request whose lease is no longer current cannot overwrite a later generation. Add a deterministic test where the first fetch exceeds the lease and completes after the second fetch.


### FV-AUD-058 — Cold-cache Statbotics failures become cached “not found” responses

**Severity: Medium / provider failure semantics**

When a Statbotics request fails and there is no prior cached representation, the catch path writes a negative cache entry with `data: null` and a retry cooldown, then rethrows the original error. The first caller therefore observes a service failure. On subsequent calls, however, `getCached` sees the negative entry as fresh and returns its `null` data without attempting the provider request. The per-match API interprets that null as a genuine missing Statbotics record and responds with HTTP 404 and `{ available: false }`.

A transient upstream outage on a cold cache is therefore converted into a successful “record not found” response for the negative-cache interval (normally at least ten minutes). Consumers cannot distinguish an actual provider 404 from a temporary provider failure after the first request.

**Action:** preserve the distinction between negative-cache results caused by an authoritative upstream 404 and cooldown entries caused by acquisition failure. Store an explicit outcome/status in the cache entry; return null only for confirmed not-found results, and return an unavailable/error state (or retry after a short bounded cooldown) for failed acquisition. Add tests for genuine 404, cold-cache network failure followed by a second request, upstream 5xx, and recovery after the cooldown.


### FV-AUD-059 — FRC Colors refresh lock has the same lease and force-refresh gaps

**Severity: Low / enrichment freshness and cache ordering**

The FRC Colors client uses a fixed 20-second Redis lock around an upstream fetch, but it does not set a request timeout or renew the lock. If the provider request outlives the lease, another request can acquire the lock and fetch the same event concurrently. Both callers write the resulting color array unconditionally, so a slower earlier request can overwrite a later response after its lock has expired. Token-checked lock release prevents deleting another request's lock, but it does not fence cache writes.

There is a related force-refresh ambiguity: when `refresh: true` is requested while another caller holds the lock, the client immediately returns the cached colors if present. The caller receives an ordinary successful result without knowing that its requested refresh did not run or observe the in-flight result. This is reachable from Event Analytics when its team-color source is explicitly refreshed.

**Action:** apply bounded fetch timeouts and lease renewal or fencing to FRC Colors cache writes, and define explicit behavior when a force-refresh encounters an active lock (join/wait for the new result or return a refresh-in-progress outcome). Add deterministic tests for a fetch exceeding the lock lease and for force-refresh contention. Consider sharing a common provider-cache/lock implementation with Statbotics so these concurrency semantics cannot drift between clients.

### FV-AUD-060 — Season-cohort refresh cannot reconcile event-roster changes

**Severity: Medium / comparison coverage and refresh correctness**

`getSeasonCohortSnapshot(event, teams)` uses the supplied event roster only when it creates a new cohort job. When a job already exists, it returns the persisted snapshot without comparing or reconciling `teams` against `job.teamNumbers`. The event analytics route calls this function with the current snapshot's team list on every request, but those later roster values are ignored. The manual refresh path in `advanceSeasonCohort` also only rebuilds `discoveryQueue` from the existing `job.teamNumbers`; it does not accept or replace the roster. Therefore, teams added to or removed from an event after the cohort job is initialized remain absent or present incorrectly in the season-cohort comparison, even after an explicit refresh. The cache's 24-hour TTL eventually causes a new job to be initialized, but the documented refresh action cannot correct the roster immediately.

This affects the cohort's team count, discovery coverage, and season-aware team comparisons. It can also make the displayed comparison population disagree with the event roster supplied by the event analytics snapshot.

**Action:** make roster reconciliation an explicit part of cohort refresh. Compare the latest event team numbers with the persisted roster, enqueue discovery for newly added teams, and remove or mark departed teams according to a documented historical-snapshot policy. Ensure manual refresh uses the latest roster rather than the original job roster. Add tests for team additions, removals, unchanged rosters, and a refresh after roster changes.

### FV-AUD-061 — Stale-on-error provider fallbacks are reported as fresh data

**Severity: Medium / source freshness and provenance**

The Statbotics and FRC Colors clients deliberately return cached data when an upstream refresh fails, but their public service methods return only the data payload and do not expose whether it came from a successful refresh or a stale fallback. In the Statbotics client, the failure path preserves the previous `fetchedAt` but updates `lastRefreshAt` and `expiresAt` to establish a retry cooldown; callers receive only `fallback.data`. In the FRC Colors client, the cache stores only the color array, and the catch path returns that array without any fetch timestamp or stale marker. Neither service communicates the upstream error when a fallback exists.

The Event Analytics worker treats these fallback returns as successful acquisitions. It sets `statboticsLoadedAt` after the collection calls complete and sets `teamColorsLoadedAt` after `FRCColors.getEvent` returns. The resulting source metadata can therefore report the source as ready with a recent `updatedAt`, even though the provider refresh failed and the displayed values are older. The Statbotics API route likewise returns the cached payload as an ordinary successful response, without freshness metadata. This hides an important distinction between “last known data is available” and “the provider was successfully refreshed.” The selected-team history route and selected-team match-analysis route have the same consumer-side ambiguity: both accept the Statbotics service's stale-on-error return as ordinary data, then derive `ready`/`statboticsAvailable` or collection completeness from record presence. The team-history route stamps the assembled payload with a new `updatedAt` and retains it for a year; the match-analysis route stamps its result and retains the current season for ten minutes. Neither response carries the underlying Statbotics `fetchedAt`, stale flag, or refresh error, so callers cannot distinguish a newly acquired model record from an old cached fallback. The team-history endpoint is currently dormant in the UI because its only caller is the unreachable two-team comparison effect (FV-AUD-093); the selected-team match-analysis route remains active. The season-cohort worker also stamps each discovered team-event record with `fetchedAt: Date.now()` and marks it `ready` whenever a Statbotics record exists, even if the client supplied that record through its stale-on-error fallback. Those false-fresh timestamps feed the cohort's prior/current EPA comparisons and its 24-hour persisted snapshot. Separately, the Statbotics client deliberately sets its effective cache lifetime to at least ten minutes (`Math.max(MIN_REQUEST_INTERVAL_SECONDS, upstreamMaxAge ?? fallbackTtlSeconds)`). If the provider advertises a shorter `max-age` or `max-age=0`, the client still serves the cached record for the ten-minute request floor. That may be an intentional rate-limit policy, but the actual provider freshness directive and the FieldView-imposed minimum are not surfaced separately to consumers.

**Action:** return a structured provider result that separates data availability from freshness and refresh outcome (for example, data, fetched-at, stale flag, last refresh attempt, and refresh error). Preserve stale-on-error availability, but propagate the stale state through API responses, EventState, and Event Analytics source metadata. Do not advance a successful-source timestamp when only a stale fallback was returned. Add tests for successful refresh, stale fallback after network/5xx failure, cold-cache failure, and subsequent recovery for both providers.

### FV-AUD-062 — Season-cohort worker can outlive its lock lease and overwrite concurrent progress

**Severity: Medium / job concurrency and data completeness**

`advanceSeasonCohort` acquires a 45-second Redis lock, but does not renew it or verify lock ownership when persisting the job. Its nominal 20-second work budget is checked only between discovery batches; it does not bound or abort the in-flight TBA and Statbotics requests inside a batch. Those provider fetches have no request timeout in the inspected clients. A slow or stalled request can therefore keep a worker running after its lock expires, allowing another dashboard request to acquire the same event lock and start a second worker.

Both workers mutate their own in-memory copy of the cohort job and persist the complete serialized job through unconditional `writeJob` calls. If the later worker writes progress first and the expired-lock owner writes afterward, the older snapshot can overwrite the newer worker's discovery results, attempts, or records. The token-checked lock release prevents an old worker from deleting a newer lock, but it does not fence the old worker's job writes.

**Action:** ensure the provider request deadline and total batch execution time fit safely inside the lease, renew the lease while work is active, or add a fencing/generation token checked atomically when committing the job. A worker that no longer owns the current generation must not write. Add a deterministic test where one discovery request exceeds the lease, a second worker completes, and the first worker attempts a late write.

### FV-AUD-063 — Selected-team match-analysis refresh leaves TBA inputs cached

**Severity: Medium / refresh completeness**

`GET /api/insights/team/[team]/matches?refresh=1` bypasses the assembled team-match-analysis Redis snapshot and passes `refresh: true` to `Statbotics.getMatches`. It does not refresh the TBA inputs: `TBA.getTeamEvents` and each `TBA.getTeamMatches` call use the ordinary cached service methods. Those service methods do not expose a refresh option, even though the lower-level TBA client supports `forceRefresh`. Consequently, an explicit refresh can rebuild the analysis with newly acquired Statbotics predictions while retaining an old TBA event roster and match schedule/results. This is especially relevant when the user is attempting to correct a stale or incomplete match history.

This is distinct from the event-analytics refresh path, which explicitly reacquires the TBA event, teams, matches, OPRs, rankings, and playoff alliances when forced.

**Action:** define refresh semantics for the assembled team-match resource and pass them through every source dependency. Expose a controlled TBA refresh option at the service boundary (or invalidate the exact TBA resources before rebuilding), while retaining normal cache behavior for ordinary requests. Return per-source acquisition/freshness metadata so a refreshed response does not imply every input was refreshed. Add tests with stale TBA schedule data and fresh Statbotics data, then verify that `refresh=1` refreshes both sources.

### FV-AUD-064 — Event Analytics “Refresh data” does not force-refresh TBA resources

**Severity: Medium / refresh semantics and snapshot correctness**

The Event Analytics refresh path calls `TBA.getEventMatches`, `TBA.getEventOPRs`, `TBA.getEventRankings`, and `TBA.getEventPlayoffAlliances` without a force-refresh option. These service methods call the TBA client with its default cache behavior, which returns a still-fresh Redis representation without contacting The Blue Alliance. The lower-level TBA client supports `forceRefresh`, but the inspected service methods do not expose it. Thus the dashboard's explicit “Refresh data” action reliably clears/reacquires the Statbotics and FRC Colors collections, but for TBA it only re-reads resources through the normal cache and may preserve the existing TBA snapshot.

The refresh also leaves the persisted event record and team roster untouched; only matches, OPRs, rankings, and playoff alliances are reconsidered. A changed event roster or event metadata therefore cannot be reconciled by this action. This compounds the season-cohort roster issue documented in FV-AUD-060.

**Action:** define what “Refresh data” promises per source. If it is intended to request current provider data, expose force-refresh controls through the TBA service and refresh all mutable resources required by the snapshot, including event metadata and team roster. If upstream request limits require honoring still-valid TBA cache entries, label the action as rebuilding from available cached sources and expose each resource's fetched-at/freshness state. Test a changed TBA response while the old Redis entry is still within max-age.

### FV-AUD-065 — Schedule and alliance webhooks refetch through still-fresh TBA cache entries

**Severity: High / live event data freshness**

The TBA webhook handler treats `schedule_updated` and `starting_comp_level` as refetch signals without invalidating or mutating the relevant Redis resources. It then broadcasts the event to EventState, whose default handler calls `reloadAll(true)`. Similarly, `alliance_selection` causes `reloadAlliances(true)`. Those client reloads call the ordinary event API routes, which call TBA service methods using the normal cache policy. The TBA client returns any unexpired cached response immediately; the reload does not force an upstream request or invalidate the cache.

Consequently, a schedule update can trigger a visible reload that simply returns the old cached match schedule. Alliance selection can likewise reload the old cached alliance response. There is an additional gap in the `match_score` path: the webhook mutates only the event-wide match schedule, while EventState also reloads team statuses, playoff alliances, and OPRs. Those resources have independent TBA cache entries, and the reloads use ordinary cache reads, so a still-fresh statuses/alliances/OPRs entry can be returned unchanged after a new score. Match scores can affect ranking/status calculations and model-derived event ratings, but none of those secondary resources is invalidated or updated by the match-score webhook. The same issue applies to any other webhook type routed through the generic full-reload path when its corresponding TBA resource cache has not expired. This is separate from the match payload cache mutation gaps documented in FV-AUD-051 and FV-AUD-055: these webhook types do not directly patch the affected resource at all.

**Action:** map each webhook type to the exact TBA resource keys it invalidates or updates before broadcasting. For `match_score`, update/invalidate the event match schedule plus affected team statuses, playoff alliances, OPRs, and any rankings/analytics resources that are expected to change. For schedule changes, invalidate the event match schedule and dependent team-scoped schedule representations; for alliance selection, invalidate the event alliance resource and dependent derived resources. Keep the normal cache policy for unrelated resources. Add integration tests with unexpired Redis entries proving that each webhook makes the next relevant API read observe updated provider data.

### FV-AUD-066 — External provider requests have no client-side deadline

**Severity: Medium / request reliability and serverless execution budget**

The shared TBA client, Statbotics client, and FRC Colors client perform upstream `fetch` calls without an `AbortSignal`, timeout, or caller-provided deadline. The YouTube oEmbed lookup in `buildStreams` is also unbounded. These paths serve event schedules, team histories, rankings, OPRs, alliances, match predictions, team EPA, event colors, and webcast metadata. A provider connection that stalls rather than promptly rejecting can therefore hold an API route, server-rendered page, or background analytics worker open until the hosting platform terminates the execution. Team-history and analytics routes declare 60-second maximum durations, while Statbotics and FRC Colors also hold finite Redis request locks around these fetches.

This amplifies the lock-expiry risks in the analytics jobs (FV-AUD-057 and FV-AUD-062) and provider cache clients (FV-AUD-057 and FV-AUD-059): a worker's nominal work budget or a lock TTL is not a provider request deadline, so an in-flight request can outlive its owner lease and execution budget.

**Action:** add configurable per-provider request timeouts and propagate cancellation/deadline budgets from callers where appropriate. Choose timeouts comfortably below the shortest relevant route/job budget, distinguish timeout from authoritative not-found and other provider failures, and ensure workers stop or safely abandon work when their deadline expires. Add tests for never-resolving fetches, timeout cleanup, and preservation of previously cached data.

### FV-AUD-067 — TBA responses and cached payloads are trusted without runtime schema validation

**Severity: Medium / provider-boundary data integrity**

The TBA client parses successful upstream JSON and immediately casts it to the caller's generic type (`as T`), then caches it. The generated OpenAPI types in `src/lib/tba/types.ts` provide compile-time contracts only; they do not validate the response at runtime. Redis cache parsing is similarly shallow: it checks only that the parsed value is an object containing `data` and `expiresAt`, then casts the entire envelope to `CacheEntry<T>`. It does not validate the expiry value, ETag, or the resource-specific data shape.

A structurally invalid but syntactically valid upstream response can therefore be stored and served as if it satisfied the TBA contract for the full provider max-age. Downstream service methods and pages assume nested fields and array/object shapes exist; malformed data can cause runtime exceptions, silently degrade calculations, or poison repeated reads from Redis. A malformed-but-envelope-shaped cache value can pass the current cache parser as well. The live EventState consumer adds another failure mode: `loadTeams`, `loadMatches`, and `loadAlliances` convert a successful non-array response to `[]` and publish it into the snapshot, replacing any previously displayed roster, schedule, or alliance data with an apparently valid empty collection. Other resources are also cast or accepted with only shallow top-level checks. Thus a 200 response with the wrong shape can become a destructive state update even when the previous snapshot was usable.

**Action:** introduce runtime validation at the TBA provider boundary for the resource shapes actually consumed by FieldView, and validate cache envelopes before trusting them. Reject or quarantine invalid provider responses rather than caching them; preserve stale known-good data where policy allows and expose validation failures distinctly from not-found. Add fixture tests for missing nested fields, wrong top-level collection types, nullability, and invalid cache metadata. Keep generated OpenAPI types as the static contract, but do not treat TypeScript casts as runtime validation.

### FV-AUD-068 — Statbotics collection pagination can loop indefinitely on an invalid page shape

**Severity: High / analytics request availability**

`StatboticsClient.getCollection` assumes each successful `getCached<T[]>` result is an array, but the shared HTTP client parses JSON and casts it to `T` without runtime validation. The pagination loop checks `page === null`, `page.length === 0`, and `page.length < pageSize`, but never verifies `Array.isArray(page)`. If the provider returns a successful but structurally invalid object (or another non-array JSON value), `page.length` is typically `undefined`; both termination comparisons are false, so the loop increments offset and continues requesting pages until the serverless execution is terminated. A provider regression can therefore turn one team-match or team-event collection request into an unbounded sequence of requests rather than a bounded acquisition failure.

**Action:** validate that every collection page is an array before appending or inspecting its length, fail the collection with an explicit invalid-response error otherwise, and add a maximum-page/maximum-record guard. Test object, null, malformed, empty, short, and full-sized page responses, including a provider that repeats the same full page for successive offsets.

### FV-AUD-069 — Statbotics lock-release errors can turn successful data acquisition into request failure

**Severity: Medium / false provider failure and avoidable data loss at callers**

`StatboticsClient.getCached` writes the successful provider response to Redis and returns the data from inside a `try`, but its `finally` block awaits `releaseLock(key, token)` without catching cleanup errors. If the Redis `eval` used to release the lock fails after the cache write succeeds, the finally rejection overrides the successful return value and the caller observes a failed Statbotics request. The cache may already contain the fresh response, but callers such as the team-match analysis route catch the error and substitute an empty Statbotics collection; the single-match API route returns 502. The finite lock TTL already provides eventual cleanup if explicit release is unavailable.

This differs from the FRC Colors client, which catches and logs lock-release failures so cleanup does not mask a successful provider result.

**Action:** make Statbotics lock cleanup best-effort, log release failures, and preserve the provider result once its cache write succeeds. Add a test where provider fetch and cache write succeed but lock-release `eval` rejects; assert the caller still receives the acquired data and the lock expires naturally.


### FV-AUD-070 — TBA webhook cache-mutation failures can be acknowledged as successful updates

**Severity: High / live event data freshness and webhook reliability**

For `match_score`, `match_video`, and `upcoming_match`, the webhook handler awaits the corresponding TBA cache mutation helper before broadcasting the WebSocket notification. However, `TBAClient.mutateCached` catches errors from the read-modify-write block (including a failed Redis `set`) and returns `false`. The higher-level `mutateMatchCaches` and `mutateUpcomingMatch` helpers ignore that boolean result, so the webhook handler cannot distinguish a successful cache update from a failed mutation. It proceeds to broadcast the event and returns HTTP 200.

A connected EventState then refetches through the ordinary TBA API route. If the existing cache entry is still within its provider max-age, that read can return the unchanged pre-webhook value. The webhook has therefore been acknowledged and delivered to clients even though the data update was not committed, and the stale cache can remain authoritative until expiry. This is distinct from webhook coverage gaps (FV-AUD-051 and FV-AUD-055) and read/write races (FV-AUD-052): this is an explicitly failed cache write that is swallowed as success.

**Action:** distinguish “resource was not cached” from “mutation failed” in the cache mutation result. Propagate actual Redis/mutation failures to the webhook handler so it can return a retryable non-2xx response, or invalidate the affected cache key as a safe fallback before broadcasting. Do not send a success signal when the cache update failed. Add tests for absent cache entries, successful mutation, Redis write rejection, and mutation callback failure; verify that failed writes are retried or that the next API read cannot serve the stale entry.


### FV-AUD-071 — Critical data paths have no automated test suite or test command

**Severity: High / regression detection and data-contract reliability**

The inspected repository has no test script in `package.json`, and the package manifest contains no test-runner dependency. Repository searches for common test declarations and test-directory conventions did not surface an automated unit/integration suite. The documented development checks are lint and build only; neither exercises behavioral contracts such as webhook-to-cache reconciliation, ETag/304 races, provider failure/stale fallback semantics, lock fencing, collection pagination, or analytics metric calculations.

This leaves the most failure-prone parts of FieldView—provider clients, Redis cache behavior, asynchronous acquisition jobs, realtime delivery, and derived analytics—without an executable regression safety net. The audit has identified multiple interacting defects in these areas; source review alone cannot establish that fixes preserve behavior or that concurrency/failure scenarios are handled correctly.

**Action:** establish a lightweight automated test harness and add focused tests around the data boundaries before broad implementation changes. Prioritize TBA cache/webhook integration (including races and failed writes), Statbotics/FRC Colors cache and lock behavior, analytics job recovery and source completeness, EventState snapshot validation/reconciliation, and pure metric calculations. Add a documented test command and ensure it runs in CI. Do not treat lint/build success as behavioral validation.


### FV-AUD-072 — Remote event cards render next-match dates in the viewer's timezone

**Severity: Medium / event-time presentation correctness**

`NextMatchCountdown` accepts an optional `eventTimezone` and uses it for both same-day comparison and the absolute date/time label when the next match is not on the current event-local day. If the prop is omitted, `Intl.DateTimeFormat` silently uses the browser's timezone. `RemoteEventCard` renders the shared component as `<NextMatchCountdown nextMatch={match} />` and has the event available from `eventState.event`, but does not pass `event.timezone`. On a remote display whose system timezone differs from the venue, a next-day match can therefore show the wrong calendar day and local clock time. This violates the event-timezone rule in AGENTS.md and differs from the other match-card call sites that pass the event timezone.

**Action:** pass the event's IANA timezone from `eventState.event` into `NextMatchCountdown` in `RemoteEventCard`. Make the component's fallback explicit and deterministic (UTC or a clearly unavailable label), rather than silently using browser-local time when event timezone is absent. Add a test with a remote/browser timezone different from the event timezone, including a match crossing midnight in one of those zones.


### FV-AUD-073 — Remote session sends unbounded full EventState snapshots over one RTCDataChannel message

**Severity: Medium / remote data delivery reliability and flow control**

The controller publishes each complete `EventStateSnapshot` as one JSON message through `RemotePeer.sendMessage`. A snapshot contains the full event match schedule, team roster, team statuses, playoff alliances, OPRs, and current Statbotics match data. On initial connection, `sendControllerState(true)` sends the surface state and then every currently held event snapshot; subsequent EventState updates send another complete snapshot. The RTCDataChannel is created with ordered delivery, but the sender does not inspect `channel.maxMessageSize` or `bufferedAmount`, split large snapshots into bounded frames, or apply backpressure/coalescing. `channel.send` is also not guarded against synchronous send errors.

This makes remote delivery dependent on the size of the event snapshot and the negotiated browser transport limits. Large event schedules or rapid updates can exceed a data-channel message limit or accumulate a large send queue. A send exception can also escape the EventState subscription callback, whose listener dispatch does not isolate listener failures, potentially interrupting delivery to other listeners in that update cycle. The current implementation has no explicit maximum snapshot size or observable delivery-failure state.

**Action:** define a bounded remote snapshot transport: measure/limit serialized payloads against the negotiated `maxMessageSize`, chunk/reassemble large snapshots with message IDs and versioning (or use a bounded alternate transfer path), coalesce superseded snapshots, and pause/resume sends based on `bufferedAmount`/low-water marks. Catch send failures without allowing one remote listener to interrupt EventState notification. Add tests with large championship-sized schedules, rapid successive snapshots, and a simulated send failure.


### FV-AUD-074 — A one-team EPA sample is reported as the 100th percentile

**Severity: Medium / analytics interpretation and sample coverage**

The shared `percentile(values, value)` helper in `src/lib/insights/calculations.ts` returns `1` whenever the comparison array contains exactly one value. The caller formats this as an event percentile in the Team Snapshot and also uses the helper for the selected team's current-event cohort comparison. If Statbotics EPA is available for only one event team, that sole observation is therefore reported as the 100th percentile, despite there being no peer observations against which to establish a relative standing. This can make incomplete provider coverage look like an exceptional rank rather than an insufficient sample.

**Action:** define single-observation percentile semantics explicitly. Prefer `null`/“insufficient cohort” when fewer than two comparable teams have usable EPA, or use a documented median-rank convention such as 50th percentile for a one-member cohort. Add tests for empty, one-value, tied, and distinct multi-value cohorts, and ensure the UI labels the comparison coverage.


### FV-AUD-075 — EPA contribution analysis drops otherwise usable alliances containing negative EPA

**Severity: Medium / analytics sample completeness and metric fidelity**

The documented `% EPA Contribution to Matches` definition uses a team's pre-match total EPA divided by the sum of all three alliance teams' pre-match total EPAs, averaged across usable appearances. In `buildTeamRows`, the contribution calculation skips an entire alliance whenever any of its three pre-match EPA values is negative (`values.some((value) => value === null || value < 0)`). Negative EPA is a valid model value, not a missing-data sentinel. When the three-team total remains positive, the documented ratio is still mathematically defined, including a negative contribution for a team below zero. The current guard therefore discards valid alliance observations and systematically excludes low-EPA teams from the contribution sample. This is distinct from the separate team-match schedule issue where negative EPA is treated as missing (FV-AUD-042).

**Action:** distinguish missing/non-finite EPA from negative EPA. Compute the documented ratio whenever all three values are finite and the alliance total is strictly positive; if a non-positive denominator is considered unsuitable, exclude that sample for the denominator reason and expose the excluded-sample count. Add tests for negative numerator with positive alliance total, zero total, negative total, and missing team EPA.


### FV-AUD-076 — Reusable Event Data Panel is documented as implemented but is absent from the application

**Severity: Medium / documented data-surface completeness**

`AGENTS.md` describes `src/components/eventdata/EventDataPanel.tsx` as an implemented reusable OPR/DPR/CCWM panel and states that it can be rendered from any client component/page. The same instructions describe `dataPanel` tile types, `panel=<key>` URL handling, and allowing the same event to appear in both an EventView and a data panel. On the audited `ui-cleanup` branch, fetching both the documented component path and `src/app/event/[event]/data/page.tsx` returns no file. Repository search finds the `EventDataPanel` name only in documentation. The actual `TileSurfaceState.tileTypes` is restricted to `"eventView"`, and `TileView` unconditionally renders `EventView` for every stream; there is no `dataPanel` branch, tile creation action, or `panel=<key>` URL handling in the inspected controller. Current initialization and `addEvent` also use the event key itself as the tile ID, and `addEvent` rejects any second tile that maps to the same event, so tile identity is not yet independent of event identity and the documented same-event/multiple-tile case cannot be represented. The implementation instructions therefore describe a data presentation capability that is not present in the implementation. The current README on this branch does not claim the panel is implemented.

**Action:** either implement the reusable panel and its `/event/<event>/data` route plus the documented `dataPanel` tile identity/URL behavior, or correct README/AGENTS to mark those statements as planned rather than implemented. When implemented, keep OPR/DPR/CCWM acquisition in EventState and make the panel consume the existing snapshot; do not add a separate fetch/cache path.


### FV-AUD-077 — Statbotics individual-resource responses and cached data lack runtime schema validation

**Severity: Medium / model-data integrity**

The Statbotics client parses successful JSON responses in `getCached<T>` and immediately casts them to the requested generic type before writing them to Redis. Its generated OpenAPI types and application aliases are compile-time contracts only. `parseCached<T>` checks the presence and numeric types of a few cache-envelope timestamps, but does not validate `etag`, the `data` value, or the resource-specific shape. The pagination array-shape gap is separately covered by FV-AUD-068; this finding concerns individual match, team-year, and team-event resources consumed throughout FieldView.

A syntactically valid but structurally invalid provider response can therefore be cached and returned as a successful typed resource. Downstream code may interpret missing nested prediction/EPA fields as unavailable, calculate partial values, or throw when it assumes nested objects exist. A malformed cached `data` value passes the envelope parser and can repeatedly poison reads until cache expiry. This also makes the freshness metadata problem in FV-AUD-061 harder to diagnose because the service has no distinct validation-failure outcome.

**Action:** validate each consumed Statbotics resource shape at the provider boundary (including nullable 404 outcomes), validate cached data before returning it, and reject/quarantine invalid responses rather than caching them. Preserve known-good stale data only under the explicit stale-on-error policy, and surface validation failure separately from authoritative not-found. Add fixtures for missing nested `pred`, `pre_epas`, `epas`, team-event EPA/record fields, wrong primitive types, and malformed cache envelopes.


### FV-AUD-078 — FRC Colors event responses and cached color records are not schema-validated

**Severity: Low / enrichment-data integrity and false-empty results**

`FRCColorsClient.getEvent` casts the upstream JSON directly to `EventResponse` and iterates `payload.teams ?? {}` without verifying that the payload or `teams` map has the expected structure. A missing `teams` property is silently converted into an empty color collection and cached for 24 hours; a wrong-shaped value can be iterated as if it were a team map, produce an empty result, or throw while reading nested `team.colors`. The cache parser checks only that the stored JSON is an array and then casts its elements to `FRCColor[]`; it does not validate team numbers, color fields, or verification flags on cache reads. A malformed successful provider response can therefore become a long-lived empty or invalid event-color result, and the analytics worker can mark that collection as successfully loaded.

**Action:** define the expected FRC Colors response contract and validate the top-level object, `teams` map, each team record, and cached color entries. Distinguish a valid event with no published colors from an invalid/incomplete provider response; do not cache malformed responses as a successful empty collection. Preserve stale known-good colors on validation/provider failure under the existing stale-on-error policy, and add response/cache fixtures for missing maps, null entries, invalid team IDs, malformed color objects, and legitimate empty results.


### FV-AUD-079 — Event Analytics refresh treats null match scores as completed results

**Severity: Low / defensive handling of malformed match data**

In `advanceEventAnalytics`, the force-refresh schedule merge decides whether the prior and incoming TBA match representations are played with expressions equivalent to `red.score >= 0 && blue.score >= 0`, without checking that either score is non-null. In JavaScript, `null >= 0` evaluates to `true`. Although the generated TBA contract declares these score fields numeric (and normally uses `-1` for unplayed matches), a malformed but syntactically valid response or corrupted persisted job containing null scores is therefore classified as played. If the persisted analytics job contains a completed result but a later TBA response supplies null scores and no actual time, `nextPlayed` can be true and the incoming incomplete representation replaces the prior completed match in `job.matches`. The low-level TBA cache has a separate result-reconciliation helper, but the analytics job repeats the comparison at its own persistence boundary and can encounter a prior job snapshot that is newer than the current TBA cache entry.

**Action:** use one shared null-safe match-result predicate for both TBA cache reconciliation and Event Analytics snapshot merging. Require actual result evidence (for example, non-null non-negative scores on both alliances, or an authoritative result timestamp/score breakdown) before treating a match as completed. Add tests for null/null, -1/-1, mixed null/-1, one posted score, and a completed cached match followed by an incomplete provider representation.


### FV-AUD-080 — Event Analytics refresh can be silently skipped when its job lock is held

**Severity: Medium / refresh semantics and stale snapshot delivery**

Both `advanceEventAnalytics` and `advanceSeasonCohort` attempt to acquire an event-scoped Redis lock and immediately return when `SET ... NX` does not acquire it. They do not distinguish an ordinary request from `forceRefresh`, wait for the lock owner to finish, or return a refresh-in-progress outcome. The API route then proceeds to read the persisted EventAnalytics and season-cohort jobs and returns those snapshots as a successful response. If a user explicitly presses “Refresh data” while another request is advancing either job, the refresh request can therefore return the pre-refresh snapshot without indicating that its requested work was skipped. This is separate from per-resource provider lock contention in FV-AUD-056 and FV-AUD-059, and from the event-job lease expiry race in FV-AUD-012 / FV-AUD-062.

**Action:** define job-level refresh contention semantics. For explicit refresh, join/wait for a newer job generation within the route budget or return an explicit in-progress response/state that the dashboard can display; do not report an ordinary successful snapshot as though the requested refresh completed. Include generation IDs and last-attempt/last-success timestamps for both event analytics and season cohort. Add concurrent tests for normal open versus refresh, refresh versus refresh, and lock timeout.


### FV-AUD-081 — TBA cache-tag indexing failure can mask a successful provider response

**Severity: Low / avoidable request failure after successful cache write**

In `TBAClient.get`, the successful upstream response is written to the primary Redis cache key before the client registers the key in its derived tag sets. The method then awaits `pipeline.exec()` for the tag-index writes before returning the already-fetched/reconciled data. If that pipeline fails after the primary cache write succeeded, the method rejects and its API/page caller observes a TBA acquisition failure even though the fresh representation is already safely cached. The next ordinary read can succeed immediately from that cache. Tag indexing is secondary metadata and its failure should not turn a completed data acquisition into a failed request; the current code has no distinction between primary cache persistence and tag-index maintenance.

**Action:** preserve the successful provider result after the primary cache write, and make tag-index maintenance best-effort with explicit logging/repair behavior. If tag indexing is required for correctness, provide a bounded retry or reconciliation mechanism without masking the successful response. Add a test where the provider fetch and primary `SET` succeed but the tag pipeline rejects; assert the caller receives the data and the tag-index failure is observable.


### FV-AUD-082 — Development startup and production builds depend on live OpenAPI documentation services

**Severity: Low / build and developer-environment reliability**

`package.json` wires both type generators into `predev` and `prebuild`, so every `npm run dev` and `npm run build` fetches the current TBA and Statbotics OpenAPI documents before Next.js starts. The generated TypeScript files are committed to the repository, but the normal startup/build path does not use those checked-in artifacts as a fallback. The Statbotics generator has a 20-second fetch timeout; the TBA `openapi-typescript` command is invoked directly against the live Swagger URL without an explicit timeout/retry/fallback in the project script. A temporary documentation endpoint outage, DNS/network restriction, or upstream schema-service change can therefore prevent local development startup or production deployment even when the application source and last-known generated contracts are otherwise buildable.

**Action:** separate routine build/start from explicit schema regeneration. Keep generated artifacts committed and have ordinary `predev`/`prebuild` consume them; run generators in a deliberate update command or CI workflow, review the generated diff, and fail that update workflow if upstream schemas are unavailable. If automatic regeneration is a deliberate policy, add bounded retries and a clearly documented last-known-good fallback. Test builds with network access to the schema endpoints disabled.


### FV-AUD-083 — Team-history provenance hardcodes the Statbotics mirror regardless of configured runtime host

**Severity: Low / source attribution accuracy**

The selected-team history route emits `source: "Statbotics mirror + The Blue Alliance"` in every successful payload. The Statbotics client chooses its runtime host from `STATBOTICS_API_BASE_URL` when configured and otherwise uses its current default mirror. If the deployment is switched to the official Statbotics API or a FieldView-operated compatible endpoint, the response continues to attribute the data to the community mirror. Consumers therefore receive incorrect provenance precisely when the project changes its provider configuration to satisfy the official-provider requirement. The route is currently dormant in the rendered dashboard (its only caller is the unreachable dual-team comparison effect tracked in FV-AUD-093), but the attribution remains wrong for any direct API consumer or future use.

**Action:** derive source attribution from the actual configured provider identity at the service boundary, or expose a stable provider identifier that is resolved from configuration without leaking credentials. Keep TBA provenance separate. Add tests for default, official, and FieldView-operated base URL configurations.


### FV-AUD-084 — Remote presence lease loss does not close the still-connected peer

**Severity: Medium / remote session exclusivity and signaling integrity**

`registerRemoteWebSocket` refreshes the role's Redis presence key every 30 seconds with a token-checked `EXPIRE`, but the interval only logs Redis errors and ignores the script's return value. If Redis is unavailable long enough for the 120-second presence TTL to expire, or the key is otherwise lost/replaced, a later refresh returns `0` because the token no longer owns the key. The existing WebSocket is not closed and its subscriber remains active. A new client can then acquire the now-free role key and connect under the same six-digit code while the old peer is still connected. Both peers can continue receiving/publishing signaling messages for that code, violating the one-controller/one-display presence invariant and potentially routing offers/candidates to multiple peers.

**Action:** treat a failed or token-mismatched lease refresh as loss of session ownership. Close the socket and run idempotent cleanup when the refresh script does not confirm the token-owned key was extended; use a bounded retry only when there is still sufficient TTL to safely recover. Add tests for Redis outage beyond the lease, a refresh returning zero, and a new peer attempting to acquire the same role after lease loss.


### FV-AUD-085 — Remote WebRTC has no TURN relay fallback

**Severity: Medium / remote display connectivity**

`RemotePeer.createPeerConnection` configures only Google's public STUN server (`stun:stun.l.google.com:19302`) and does not provide any TURN server. STUN helps peers discover public-facing address candidates, but it does not relay media/data when the peers' NATs or network policies prevent a direct ICE path. Displays and controllers behind restrictive/symmetric NAT, UDP-blocking firewalls, or some enterprise networks can therefore fail to establish the data channel even though their signaling WebSockets connect successfully. The current code restarts the peer after an explicit failed/closed connection state, but it has no relay candidate to fall back to.

**Action:** decide whether remote connectivity is expected to work across arbitrary public networks. If so, configure a credentialed TURN service (with UDP and TCP/TLS relay options) and include it in the ICE server list; keep credentials short-lived and server-issued. Add connectivity tests across same-LAN, typical home NAT, and restrictive-network/TURN-only scenarios, and expose a clear connection failure reason rather than leaving the user at an indefinite “Connecting” state.


### FV-AUD-086 — Per-tab fallback WebSocket never shuts down when its final consumer leaves

**Severity: Medium / idle connection and reconnect lifecycle**

When SharedWorker is unavailable, `sharedWorkerClient` switches to fallback mode and creates per-tab `EventState` instances that use the singleton `eventWebSocket` from `src/lib/realtime/client.ts`. EventState unsubscribes its event handlers when its final subscriber leaves, and `registerSharedLiveRuntime` removes its status subscription when the final live-runtime lease is released. However, `EventWebSocketManager` has no stop/release lifecycle: removing the last event handler does not close its socket, cancel a pending reconnect timer, or reset `started`. Its `close` handler schedules reconnect unconditionally, even when both the event-handler and status-handler sets are empty. A tab that used the fallback can therefore retain an idle WebSocket and continue reconnecting after all live pages and event subscriptions have gone away.

This violates the documented idle-teardown invariant. The normal SharedWorker-owned path has its own lease/watchdog cleanup; the leak is specific to the per-tab fallback path and can multiply across tabs when SharedWorker is unavailable.

**Action:** give `EventWebSocketManager` explicit consumer/lease accounting and an idle shutdown path. When no event subscriptions or runtime leases remain, cancel reconnect timers, close the socket, clear its started state, and avoid reconnecting. Add tests for last-event unsubscribe, last-runtime-lease release, disconnect while idle, and subsequent fresh subscription/reconnect.


### FV-AUD-087 — Repeated asynchronous SharedWorker startup errors cause immediate recreation loops

**Severity: Low / live-runtime startup reliability**

`sharedWorkerClient.connect` catches synchronous `new SharedWorker(...)` construction failures and switches to the per-tab fallback, but errors emitted asynchronously by the worker are handled differently: the `error` listener calls `recover()`, and `recover()` immediately calls `connect()` again whenever listeners or live-runtime leases remain. There is no retry delay, attempt counter, or fallback threshold for repeated worker-script startup/runtime errors. If the worker bundle consistently fails after construction (for example, a deployment asset mismatch or module-load error), the tab can repeatedly create and tear down workers in a tight loop rather than reaching the existing fallback path.

**Action:** apply bounded exponential backoff to asynchronous worker recovery and switch to per-tab fallback after a small number of consecutive startup failures. Reset the failure counter only after a worker has demonstrated health (for example, a successful ready/pong handshake). Add tests for transient recovery and persistent worker-script failure without rapid recreation.


### FV-AUD-088 — Homepage match summaries remain cached after TBA webhook updates

**Severity: Low / homepage data freshness**

The homepage wraps its event list and per-event `lastMatch`/`nextMatch` summaries in Next.js `unstable_cache` with a one-hour revalidation interval and the `homepage-events` tag. The TBA webhook handler mutates the underlying Redis TBA cache and broadcasts live-event notifications, but it does not revalidate the Next.js `homepage-events` cache tag. The homepage does not subscribe to the event WebSocket either. Consequently, a match-score or schedule webhook can update the canonical TBA cache and live EventState consumers while the homepage continues serving its previously cached last/next match summary until the one-hour ISR cache expires. This is separate from the homepage's inability to distinguish a match-fetch failure from an empty schedule (FV-AUD-034).

**Action:** decide and document the homepage freshness target. If match summaries should reflect important live updates, revalidate the `homepage-events` tag after relevant webhook cache mutations (or update the cached summary through a safe event-specific mechanism). If one-hour staleness is intentional to protect SSR/provider cost, expose the snapshot's generated-at time and keep the limitation explicit. Add a test proving the chosen behavior after a match-score and schedule webhook.


### FV-AUD-089 — Non-Twitch TBA webcast types are incorrectly treated as YouTube streams

**Severity: Medium / webcast source correctness and stream availability**

The generated TBA `Webcast` contract supports multiple types: `youtube`, `twitch`, `ustream`, `iframe`, `html5`, `rtmp`, `livestream`, `direct_link`, `mms`, `justin`, `stemtv`, and `dacast`. `buildStreams` handles `twitch` specially but sends every other type through the YouTube oEmbed lookup and constructs a `youtube.com/embed/<channel>` URL. The resulting `BuiltStream` type is restricted to only `"twitch" | "youtube"`. Valid TBA webcast entries using iframe, HTML5, direct-link, or other supported provider types are therefore misidentified as YouTube videos and will generally produce invalid metadata/embed URLs instead of a usable stream. The current fallback also makes an unsupported provider look like a broken YouTube stream rather than explicitly unavailable.

**Action:** branch explicitly on the TBA webcast type. Implement safe, provider-specific adapters for the types FieldView intends to support, and deliberately omit/report unsupported types rather than coercing them to YouTube. For iframe or direct HTML content, use strict provider/domain allowlists and safe URL parsing; do not inject arbitrary provider-supplied HTML. Add fixtures for every TBA webcast type and verify unsupported types remain clearly unsupported without generating invalid YouTube URLs.


### FV-AUD-090 — Unknown or unavailable webcast status is displayed as definitively offline

**Severity: Low / provider-status accuracy**

`getEventWebcastStatus` returns `"Live"` if any webcast has status `online`; otherwise, if the event has at least one webcast entry, it always returns `"Offline"`. The generated TBA contract defines webcast status as `unknown`, `online`, or `offline`, and the status field may also be null when the provider cannot determine it. An event whose webcast status is unknown or unavailable is therefore presented in the Events Browser as definitively offline. This conflates a known negative state with missing/indeterminate provider information.

**Action:** preserve the three-way status distinction in the formatter and UI (for example, Live, Offline, Status unavailable/Unknown). Only report Offline when all relevant webcast entries are explicitly offline; report Unknown when no stream is online and at least one status is unknown/null. Add tests for mixed online/offline, all offline, all unknown, null status, and no webcast entries.


### FV-AUD-091 — Standalone TBA match refresh bypasses completed-result reconciliation

**Severity: Medium / match-result persistence correctness**

`isMatchEndpoint` explicitly classifies `/match/<matchKey>` as a match resource, but `reconcileMatchData` only performs reconciliation when both incoming and cached values are arrays. The standalone `TBA.getMatch(matchKey)` representation is a single match object, so it returns the incoming object unchanged and never calls `reconcileMatch`. If TBA returns a temporarily incomplete/regressed standalone match representation after a completed result was cached, the refresh can overwrite the known-good result fields. Event/team match-list endpoints receive the array reconciliation behavior, but the standalone match-detail endpoint does not. This matters independently of FV-AUD-051: that finding covers webhook updates not reaching the standalone cache, while this finding covers result regression when that standalone cache is later refreshed from TBA.

**Action:** branch explicitly for standalone match objects and reconcile the incoming object against the cached object with the same result-preservation policy used for array entries. Keep schedule deletion semantics separate from same-key result preservation. Add tests for a cached completed standalone match followed by an incomplete incoming object, a normal newer result, and an unrelated match key.


### FV-AUD-092 — Match reconciliation treats any posted score as a complete replacement for cached result details

**Severity: Medium / result-field regression and match-data completeness**

The array reconciliation helper `reconcileMatch` preserves a cached match only when `hasMatchResult(cached)` is true and `hasMatchResult(incoming)` is false. However, `hasMatchResult` returns true when either alliance has a non-negative score, even if the incoming object has null/missing `actual_time`, `post_result_time`, or `score_breakdown`. In that case the entire incoming match object replaces the cached object. A partial provider representation that retains a score but omits result metadata or score breakdown can therefore erase richer result fields already present in Redis. The full-object spread used by `mutateMatchCaches` has the same field-level overwrite behavior for webhook payloads. The boolean “has some result” check is not sufficient to establish that the incoming representation is at least as complete as the cached one.

**Action:** define field-level result reconciliation for same-key matches, distinguishing an authoritative null from an omitted/not-yet-published field. Preserve known-good result metadata when an incoming update is partial, while still accepting genuinely newer score/result changes. Add fixtures for score-only, timestamp-only, breakdown-only, fully populated, and explicitly corrected result payloads; test both provider refresh and webhook mutation paths.


### FV-AUD-093 — Unreachable two-team history comparison state remains in the dashboard

**Severity: Low / dead code and incomplete analytics surface**

`EventAnalyticsDashboard` declares `teamA` and `teamB` selection state, two team-history payload states, a history loading flag, `selectedB`, `commonMatches`, and a dual-history `Promise.all` effect. However, `setTeamB` is never called, and `historyA`, `historyB`, `historyLoading`, `selectedB`, and `commonMatches` are never read by the rendered UI. The effect therefore always exits through its `!teamA || !teamB` guard in the current application and never performs the two history requests. A second match-analysis state (`matchAnalysisB`) is likewise declared but unused. This is not a currently observable partial-fetch failure; it is leftover/incomplete two-team comparison code that makes the dashboard's actual supported workflow harder to distinguish from abandoned functionality.

**Action:** either remove the unused state/effect and keep the dashboard's supported one-team investigation flow explicit, or implement the two-team comparison deliberately with visible controls and per-team request/error state. Do not retain unused network/data state as if a comparison surface already exists.


### FV-AUD-094 — Persisted Event Analytics jobs have no job-schema version or complete migration boundary

**Severity: Low / persisted snapshot compatibility**

The progressive Event Analytics job is stored under the unversioned key prefix `insights:progressive:<event>` with a one-year Redis TTL. The `Job` record itself has no `schemaVersion`; `readJob` accepts it after only checking that `event` is truthy, `matches` is an array, and `records`/`attempts` are truthy. It then backfills one freshness field, but does not validate nested event/match/record/attempt shapes or migrate other fields. The response envelope has `schemaVersion: 1`, but that does not version the persisted job that is read and mutated across deployments. A deployment that changes the internal job shape can therefore accept an older persisted job and either silently misinterpret missing fields or fail later during calculation/refresh. The one-year retention extends this compatibility window.

**Action:** add an explicit persisted-job schema version and a deliberate migration/rebuild policy. Validate required nested structures before accepting a job; if a migration is not supported, discard/rebuild the incompatible job rather than partially casting it. Keep the public EventAnalytics response schema version separate from the Redis job schema version. Add fixtures for the current job and each supported prior version.


### FV-AUD-095 — Team detail page fans out every event's data requests without a concurrency bound

**Severity: Medium / provider load and team-page reliability**

After loading a team's season event list, `src/app/team/[team]/page.tsx` uses `Promise.all(teamEvents.map(...))` to build every event section concurrently. Each event section then issues its own parallel requests for the event record, the team's match schedule, team event status, awards, advancement points, and event rankings (with playoff alliances also loaded for the section). A team with many official events can therefore trigger dozens of simultaneous TBA service calls on a cold cache. One slow/failing request also rejects the outer `Promise.all` and prevents every other successfully loaded event section from rendering (the latter page-level failure mode is tracked in FV-AUD-030).

This differs from the selected-team match-analysis route, which at least bounds event schedule and match-row concurrency. The team page has no equivalent limit or per-event outcome collection.

**Action:** bound event-section concurrency and collect per-event results independently. Preserve completed sections when one event's optional resource fails, expose which resource/event is incomplete, and keep a reasonable cap on concurrent TBA requests during cold-cache team-page loads. Add tests with many events and one failing optional request, verifying that request concurrency remains bounded and successful sections still render.


### FV-AUD-096 — Qualification model-upset flags are derived in the dashboard instead of the analytics service

**Severity: Low / analytical calculation ownership and consistency**

`QualificationAnalysisPanel` in `EventAnalyticsDashboard.tsx` derives the `modelUpsets` list directly in the browser by reading each match's Statbotics `red_win_prob`, choosing the favorite alliance, calculating the favorite probability, comparing it with the 60% upset threshold, and checking the winning alliance. This is an analytical classification rather than display-only formatting. It is separate from the server-provided 80% `highConfidenceMisses` list and from the Suggested Review client calculations tracked in FV-AUD-014. Keeping this threshold and classification in the dashboard makes the result unavailable to other consumers and creates another place where probability validation and upset semantics can diverge.

**Action:** calculate the 60% model-upset classification in the server-side EventAnalytics service, return a typed list with match key, favored alliance, favored probability, and actual winner, and have the dashboard render that result. Share the same probability-boundary validation used by other Statbotics-derived calculations. Add tests for 50/50, exactly 60%, below/above threshold, invalid probabilities, and each winning alliance.


### FV-AUD-097 — Cross-phase residual metrics are weighted by all matches instead of prediction sample size

**Severity: Medium / analytics aggregation accuracy under partial Statbotics coverage**

The team-match API's `summarize(items)` reports `matches: items.length`, which counts every completed match with known actual scores, including matches with no Statbotics prediction. Its `meanResidual`, `meanAbsoluteError`, and `rootMeanSquareError` are calculated only from `scored` rows whose residual is non-null. The dashboard's `PhasePerformancePanel` then combines qualification/elimination phase summaries by weighting those residual metrics with `item.matches`; its combined RMSE uses the same total-match weights. When Statbotics coverage differs between phases or is incomplete within a phase, a phase's residual metric is therefore weighted by matches that contributed no residual observation. The displayed combined mean residual, MAE, and RMSE can be biased and do not represent the pooled prediction sample. The same `summarize` shape is used for the overall summary and each event summary: `matches` counts all completed matches, while residual metrics use only rows with a prediction. Those payloads do not expose a separate residual/prediction sample count, so their displayed coverage denominator can also overstate the actual prediction sample.

The dashboard already uses each RP metric's explicit `sampleSize` when combining RP accuracy/Brier scores, so the residual metrics need an equivalent denominator rather than reusing the match count.

**Action:** return an explicit `predictionSampleSize` (or residual sample count) in each phase summary and use it to pool mean residual and MAE. Pool RMSE using the sum of squared-error totals or weight phase MSE by residual sample count before taking the square root. Keep `matches` for record/coverage display. Add tests with unequal Statbotics coverage across phases and within a phase, verifying the dashboard aggregation matches a direct calculation over all available residual observations.


### FV-AUD-098 — Alliance EPA totals accept incomplete team rosters as complete three-team totals

**Severity: Medium / alliance-comparison metric integrity**

The documented alliance EPA total is the sum of the pre-match EPA values for all three robots on the alliance. `buildAllianceResults` in `src/lib/insights/calculations.ts` computes `preEpaTotal` by summing whatever `alliance.team_keys` contains, without requiring exactly three unique team keys. The selected-team match-analysis route applies the same pattern to `alliancePreEPATotal` and `opponentPreEPATotal`. If a successful but incomplete TBA match representation contains only one or two team keys, and Statbotics has EPA for those listed teams, the code produces a numeric partial sum that is treated as the full alliance total. That partial value can then feed peer-band matching, comparisons, and review output as if all three robots were represented. `buildTeamRows` checks only that the array length is three for its separate contribution calculation; it does not verify three distinct team keys. The validation policy is therefore inconsistent across analytics paths and still permits a duplicated key to be counted twice.

**Action:** require exactly three distinct team keys and a finite pre-match EPA for each before emitting a complete alliance total. Otherwise return null and expose roster/coverage incompleteness rather than summing a partial alliance. Add tests for zero, one, two, three, four, and duplicate team keys, plus missing EPA for one of three teams.


### FV-AUD-099 — A transient Statbotics failure can freeze incomplete team history for a year

**Severity: Medium / latent API data completeness and recovery**

The team-history route catches Statbotics season and team-event acquisition failures independently, substituting `null` and `[]`, then continues to build a successful payload. It marks every official event without a returned Statbotics record as `status: "unavailable"`, stamps the payload with `updatedAt: Date.now()`, and writes the result to Redis with a 365-day TTL. The next request returns that assembled cache entry before attempting either provider again. Because the route has no `refresh=1` path (FV-AUD-002), a temporary Statbotics outage or cold-cache acquisition failure during the first history request can therefore turn a recoverable provider failure into a year-long incomplete team-history snapshot. The client-level Statbotics retry cooldown is not sufficient: the outer team-history cache prevents the route from reaching the provider after that cooldown expires. The route is currently not called by the active dashboard UI because its only in-repository caller is the unreachable dual-team comparison effect (FV-AUD-093), so this is a latent API/data-recovery defect until that feature is wired or another consumer calls the endpoint.

**Action:** do not cache a provider-failed team-history build as a year-long completed snapshot. Preserve partial TBA/Statbotics results with explicit per-source outcome and freshness metadata, use a short retry TTL for failed/missing provider acquisition, and provide an explicit refresh/invalidation path. Completed historical snapshots may retain long-term caching only after required sources have been successfully acquired or the missing-source state is known to be authoritative. Add tests for cold-cache provider failure, recovery after the Statbotics cooldown, partial provider success, and explicit refresh of a year-old snapshot.
