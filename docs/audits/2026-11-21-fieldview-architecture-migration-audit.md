# FieldView Architecture Migration Branch Audit

**Audit date:** 2026-11-21 (America/New_York)  
**Repository:** ThraceAerospace/frc-gameday  
**Branch:** fieldview-architecture-migration  
**Audited source HEAD:** 962d991fb336ea94f97917ebaadd513fd21d82be  
**Comparison baseline:** e2a6edbc (previous audit baseline)  
**Audit type:** Static architecture, correctness, resource-utilization, Cloudflare-platform and documentation audit

## 1. Executive assessment

**The migration has made substantial progress, but this branch is not ready for production cutover.**

The per-event EventRuntime / per-team TeamRuntime / global TaskScheduler ownership model is a sound direction. The main event and team pages now consume canonical Worker publications, team investigation has moved off the old Redis-backed analytics service, the WebSocket multiplexer uses Durable Object hibernation, and the Worker test suite is materially better than it was at the previous audit.

The remaining problems are not primarily missing architecture. They are incomplete ownership boundaries, storage amplification, unreliable cross-object notification, redundant cross-object work, incomplete production configuration, and stale documentation.

The highest-priority issues are:

1. EventRuntime retains unbounded, write-only provider-version and webhook records, including full payloads.
2. Every 304 poll rewrites the full endpoint-state object, including large unchanged payloads. EventRuntime stores both reconciled data and providerData even for resources where they are identical.
3. TeamRuntime rewrites a complete season analytics response merely to advance checkedAt.
4. TeamRuntime treats freshness-only changes as canonical snapshot changes and notifies every related EventRuntime. Its notification method does not inspect HTTP response status and has no durable retry.
5. EventRuntime team analytics fan-out is all-or-nothing on a single TeamRuntime failure and sends the full event state and comparison input to every participant.
6. TaskScheduler still performs provider I/O for an event-owned endpoint.
7. The current HEAD has no successful CI validation among the latest 50 workflow runs; its latest run was cancelled before any steps executed.
8. Several architecture documents describe code that has already been removed or contradict the current runtime policy.

The branch is best described as **a working migration prototype with incomplete production hardening**, not a completed migration.

## 2. Scope, comparison and limitations

### Repository comparison

GitHub's comparison between e2a6edbc and the audited HEAD reports:

- 1,203 commits ahead of the baseline.
- 128 changed files.
- 79 modified files, 37 added files and 12 removed files.
- Approximately 16.6 MB of tracked repository content.

The two committed operational artifacts under logs/ account for approximately 13.6 MB, or roughly 82% of the tracked repository size:

- logs/09-21-26/FieldView Runtime 2026mmr logs-2026-11-21T18_17_11.875Z.json
- logs/09-21-26/FieldView_Runtime_2026mmr.har

Their paths and sizes were inspected, but their contents could not be retrieved through the repository file interface. They have therefore **not** been cleared for secrets, credentials, cookies, personal information or sensitive response data. This is an explicit audit limitation.

The tracked source, tests, packages, runtime configuration and documentation were inventoried and statically reviewed. The critical runtime, storage, routing, UI and CI paths received deeper line-level review.

This is a static repository audit. It does not establish the current contents of Cloudflare dashboard variables, deployed bindings, production routes, production secrets, or live Durable Object storage. The migration plan also states that the deployed prototype Worker predates the latest TeamRuntime Statbotics refresh-policy correction. Current branch code must not be assumed to be the code currently running in the prototype.

### Severity

- **P1:** Correctness, durability, reliability, security or release-readiness issue to resolve before production cutover.
- **P2:** Significant resource, architecture, maintainability or user-facing correctness issue.
- **P3:** Cleanup, observability or scale risk that should be addressed before or during production hardening.

## 3. Comparison with the previous audit

### Resolved or materially improved

| Previous concern | Current status |
|---|---|
| Team match-investigation route performed legacy Redis/provider-backed aggregation | Resolved. The route is now a thin canonical Worker proxy. |
| Progressive analytics and season-cohort orchestration remained in Next.js | The old orchestration files have been removed from the active implementation. |
| Event and team data had no clear durable owner | EventRuntime and TeamRuntime now own their respective event/team resources. |
| Event state and analytics were primarily assembled in the old Next.js service path | Canonical Worker publications and analytics state now exist. |
| No meaningful Worker test suite | Substantial endpoint-state, reconciliation, EventRuntime, TeamRuntime, TaskScheduler, webhook and multiplexer tests now exist. |
| Team event state copied full match records | TeamEventState now stores EventRuntime match references rather than full copied match records. |
| EventRuntime publication embedded duplicated TeamRuntime event-state records | The old embedded EventView publication is retired; current event analytics records team-state revisions/references. |
| WebSocket coordination depended entirely on the old Vercel/Redis path | A Cloudflare Durable Object multiplexer now handles canonical subscriptions and uses WebSocket hibernation. |
| Team and event pages were coupled to provider-shaped response payloads | The main event/team pages now consume FieldView domain snapshots. A dashboard compatibility adapter remains. |
| District-owned aggregate data was part of the proposed runtime | The current ownership decision removes district-owned runtime aggregation. |

### Still present

- Redis remains active for remote-session signaling and the legacy Vercel WebSocket bridge.
- The TBA webhook relay still broadcasts to the old Redis WSS channel after Worker reconciliation succeeds.
- The legacy EventState client model and SharedWorker subscription protocol remain available.
- The analytics dashboard still has a provider-shaped compatibility contract and adapter.
- Old TBA, Statbotics and FRC Colors client/service modules remain in the web application.
- Provider types still enter the client module graph.
- EventRuntime still contains full team profiles in event state, and TeamRuntime still contains full event records in team state. ADR-0016 explicitly identifies these as remaining ownership/normalization targets.
- Production authentication, routing and cutover are not complete.

### New or newly visible issues

The new architecture introduces durable state and cross-object coordination at a much larger scale. That makes write amplification, retention, cross-object failure handling, and storage limits materially more important than they were in the previous architecture. The findings below are specific to those new paths.

## 4. P1 findings — resolve before production cutover

### P1-01 — Unbounded, write-only EventRuntime history

**Files:** workers/fieldview-runtime/src/event-runtime.ts; workers/fieldview-runtime/src/source-record.ts

EventRuntime writes immutable provider response versions under the source prefix. Each ProviderSourceVersion includes the complete provider response payload.

The current implementation has no corresponding read path, retention policy, compaction job or deletion path for these source records. The source key helper is used by the writer, but no reader was found.

Webhook idempotency records have a similar problem. The webhook record stores receivedAt, messageType and the complete rawPayload. The raw payload is not needed to determine whether the webhook ID has already been seen; the current dedupe operation only needs to establish whether the key exists. No retention or cleanup path was found.

This is both storage growth and write amplification:

- A changed provider response is stored in endpoint state.
- The endpoint state already retains providerData.
- A source-version record stores the provider response again.
- A webhook can create another full raw-payload copy.
- All of these records remain in the event Durable Object indefinitely.

The source-version feature may have a legitimate provenance/audit purpose, but it currently has no retrieval interface. A write-only audit archive is not a usable audit system.

**Recommendation:** Keep compact source metadata in EventRuntime (endpoint, validator revision, retrieved time, ETag, content hash and archive pointer). Move full immutable payload versions to R2 if they are genuinely required. Give the archive an explicit retention policy. Store only webhook ID, timestamp, message type and optionally a body hash in the dedupe record. If raw webhook bodies are required for forensics, archive them separately in R2.

Relevant code: event-runtime.ts around SOURCE_PREFIX, sourceStorageKey, source-version writes and webhook record creation; source-record.ts ProviderSourceVersion.

### P1-02 — Full endpoint payload is rewritten on every 304

**Files:** workers/fieldview-runtime/src/event-runtime.ts; workers/fieldview-runtime/src/team-runtime.ts; workers/fieldview-runtime/src/endpoint-state.ts

Both runtime poll paths persist the resulting endpoint state after applying a response. This includes 304 not-modified responses.

On a 304, applyPollResponse preserves the existing data and providerData payloads and changes freshness metadata such as lastFetchedAt, expiresAt and lastAttemptAt. The caller nevertheless writes the complete endpoint-state object again.

This is particularly expensive in EventRuntime because EndpointState always contains both:

- data: the locally reconciled representation
- providerData: the exact provider representation

For non-match endpoints, reconcilePolledEndpoint simply returns the fetched representation unchanged. Therefore data and providerData are identical for those endpoints, but both are serialized and persisted.

The dual representation is justified for match resources where webhook reconciliation can make data differ from providerData. It is not justified for every endpoint.

The effect is that a successful 304 can rewrite a large unchanged payload, sometimes twice within the same JSON value. The provider has explicitly said the representation has not changed, but the Worker still writes it.

**Recommendation:**

1. Separate endpoint metadata from the retained payload.
2. On 304, update only the small metadata record.
3. Keep providerData only for resources where webhook reconciliation actually requires the upstream representation separately.
4. For all other resources, retain one payload representation.
5. Add storage-write-count tests for 200 changed, 304, stale 304, failure and webhook paths.

Relevant code: event-runtime.ts poll persistence around lines 1970–1990; team-runtime.ts poll persistence around line 1073; endpoint-state.ts EndpointState and applyPollResponse.

These are Durable Object storage writes, not SQL row writes. The repository does not currently use storage.sql.exec or transactionSync.

### P1-03 — One TeamRuntime failure can abort an event's team analytics fan-out

**File:** workers/fieldview-runtime/src/event-runtime.ts

collectTeamAnalyticsInputs can represent missing TeamRuntime inputs as partial coverage. However, calculateTeamEventStates then iterates the event roster and performs a POST to each TeamRuntime's event-analytics endpoint.

If any POST returns a non-OK response, the method throws. The fan-out is implemented with Promise.all and has no per-team failure boundary. One failed TeamRuntime can therefore reject the entire calculation instead of returning successful team results plus an explicit missing/failed result for that team.

This is inconsistent with the partial-coverage model already represented in the event analytics publication.

It also creates a dependency problem: an event's aggregate analytics update becomes dependent on every participating TeamRuntime responding successfully at the same time.

**Recommendation:** Use per-team error handling or Promise.allSettled. Preserve successful results, record the failed team and its status, and publish an explicit partial coverage result. Retry failed participants independently. Add a test where one of several TeamRuntime calls returns 500 and verify that the other team results are still published.

Relevant code: event-runtime.ts collectTeamAnalyticsInputs and calculateTeamEventStates, approximately lines 1010–1155.

### P1-04 — TeamRuntime notifications silently discard HTTP failures

**File:** workers/fieldview-runtime/src/team-runtime.ts

notifyEventRuntimeStateChange awaits stub.fetch but never checks response.ok or the response status.

The caller's try/catch only catches thrown network/runtime errors. A normal HTTP 500, 404 or 503 response resolves as a Response and is treated as successful delivery.

There is no durable outbox or retry record for failed event notifications.

This can leave EventRuntime's team-state revision and analytics invalidation behind the TeamRuntime's actual state. The comment that a failed notification is recoverable through the next scheduled refresh is not a reliable delivery guarantee.

**Recommendation:**

- Check response.ok and treat non-2xx responses as failures.
- Persist failed notifications with event key, team key, revision and retry time.
- Retry with bounded backoff.
- Make notification handling idempotent by revision.
- Record notification success/failure metrics.

Relevant code: team-runtime.ts notifyEventRuntimeStateChange and notifyEventsOfSeasonStateChange, approximately lines 1088–1120.

### P1-05 — Current branch HEAD has no successful CI validation

**Files:** .github/workflows/ci.yml; package.json

The latest 50 workflow runs returned for this branch were all cancelled. The run associated with the current HEAD was cancelled before any job steps executed.

This means the current branch head has not been demonstrated to pass the current test/typecheck workflow.

Additional CI weaknesses:

- Lint is explicitly non-blocking.
- No Next.js production build is run.
- No Wrangler deploy dry-run is run.
- There is no Cloudflare-runtime integration test against actual Durable Object behavior.
- Root typecheck does not have an explicit typecheck target for every provider workspace.
- The provider-frc-colors package test is not included in the root test script.
- The branch is not protected by GitHub branch protection metadata.

**Recommendation:** Obtain a clean successful run on the current HEAD before merging. Add a blocking production build and Wrangler dry-run. Add the missing provider test. Require the validation workflow on the target branch. The exact reason the recent runs were cancelled cannot be inferred from their status alone.

### P1-06 — Production Statbotics configuration does not declare the required mirror

**Files:** workers/fieldview-runtime/wrangler.toml; workers/fieldview-runtime/wrangler.prototype.toml; packages/providers/statbotics/src/client.ts

StatboticsApiClient defaults to https://api.statbotics.io. The prototype configuration explicitly supplies the Iterative Refinement mirror. The production-oriented wrangler.toml does not declare STATBOTICS_API_BASE_URL.

The migration plan says the official API is unavailable and that the configured mirror is being retained while the official service is unavailable.

If the production Worker is deployed from the checked-in production config without an external override, it will use the unavailable official endpoint.

**Recommendation:** Declare the approved mirror in the production Worker configuration or verify and document the external Worker variable. Add a deployment configuration test that fails when the selected Statbotics endpoint is inconsistent with the current service decision.

The production config has workers_dev=false and no checked-in route/custom-domain declaration. This appears consistent with the decision not to cut over production traffic yet, so it is not treated as a current defect. A route/custom domain must be explicitly configured at cutover.

### P1-07 — Prototype admin bearer authorization is not a production authorization design

The runtime requires RUNTIME_ADMIN_TOKEN for administrative endpoints. The project notes already identify this as temporary prototype/test authorization.

Do not carry the prototype shared bearer token into production. Production administrative authorization needs an explicit system-administrator authorization model, a clear trust boundary between Vercel and the Worker, and an auditable authorization path. Do not treat possession of a static prototype token as the final user authorization model.

## 5. P2 findings — significant correctness and resource issues

### P2-01 — Freshness-only TeamRuntime changes cause publication writes and cross-object notifications

**File:** workers/fieldview-runtime/src/team-runtime.ts

The TeamRuntime snapshot input/representation signatures include lastFetchedAt and expiresAt. A 304 updates lastFetchedAt even though the source revision and representation have not changed.

The alarm path compares previous and current snapshots using JSON.stringify. Because source freshness metadata changes, the snapshots compare unequal. The code then calls notifyEventsOfSeasonStateChange.

The snapshot revision itself advances only when the underlying source revision changes. Therefore a freshness-only update can trigger:

- a full TeamRuntime publication rewrite,
- a new snapshot representation/ETag,
- a notification to every relevant EventRuntime,
- cross-object requests carrying the same team source revision.

The EventRuntime can ignore an unchanged revision, but the cross-object calls have already occurred.

**Recommendation:** Compare canonical data revision separately from freshness metadata. Notify EventRuntime only when the team source revision or relevant canonical data actually changes. Keep freshness metadata independently readable if it must be updated after 304.

Relevant code: team-runtime.ts inputSignature/representationSignature around lines 440–470 and notification comparison in the alarm path around lines 1248–1263.

### P2-02 — Season analytics cache hit rewrites the complete response to update checkedAt

**File:** workers/fieldview-runtime/src/team-runtime.ts

The public season analytics endpoint treats the cache as stale after five minutes. The background builder checks whether the source revisions have changed.

If the input signature is unchanged, the cache-hit path still writes the entire cached object again with a new checkedAt timestamp.

The response payload has not changed. Only the freshness timestamp has changed.

For a large season analytics response containing event summaries, match evidence and diagnostics, this is a full-value write for a metadata update.

**Recommendation:** Store checkedAt in a separate small metadata key/SQL row, or avoid rewriting the response when its revision signature is unchanged. Add a test asserting that an unchanged cache hit does not rewrite the full response blob.

Relevant code: team-runtime.ts publicSeasonAnalyticsRead around lines 372–426; buildSeasonAnalyticsResponse cache-hit path around line 869.

### P2-03 — Event analytics fan-out is unnecessarily expensive

**File:** workers/fieldview-runtime/src/event-runtime.ts

For each participant, the current flow first reads TeamRuntime state, then calculateTeamEventStates:

1. POSTs the full event_state and full comparison_input to TeamRuntime /event-analytics.
2. Performs another GET to TeamRuntime /event-state to retrieve the state that the POST just calculated.

That is approximately three TeamRuntime requests per participant when the initial input collection is included.

The POST response is not used as the resulting TeamEventState. The second GET is a separate cross-object call.

The same complete eventState and comparisonInput are serialized and sent to every TeamRuntime. Each TeamRuntime only needs its own team's event context and matches, plus the comparison context needed for its calculation.

For an event with T teams, this creates approximately 3T cross-object requests and potentially O(T²) transferred data because each team receives a copy of event-wide data.

The fan-out is also unbounded Promise.all concurrency.

**Recommendation:**

- Return the resulting TeamEventState and revision directly from the POST response.
- Send a team-specific input containing only that team's match/event context.
- Compute shared comparison aggregates once and pass a compact summary or reference.
- Use bounded concurrency for large events.
- Prefer typed Durable Object RPC for these internal operations.

### P2-04 — TaskScheduler performs provider I/O for an EventRuntime-owned endpoint

**File:** workers/fieldview-runtime/src/task-scheduler.ts

processEventTeamSeed directly requests TBA's eventTeams endpoint to discover participants.

EventRuntime already owns the eventTeams endpoint, its validator, its cached representation and its canonical event state. TaskScheduler should orchestrate participant seeding, not independently acquire an event-owned resource.

This also duplicates a provider request that EventRuntime will acquire for the event.

**Recommendation:** Ask EventRuntime to ensure/read its event-team representation and return the participant team keys. TaskScheduler should then seed the corresponding TeamRuntime objects. Add a test that TaskScheduler does not use its provider client for event-owned resources.

Relevant code: task-scheduler.ts around line 1026. This conflicts with ADR-0014's runtime ownership model.

### P2-05 — TaskScheduler registry arrays cause O(N²) write amplification

**File:** workers/fieldview-runtime/src/task-scheduler.ts

The global TaskScheduler stores registry:teams, registry:events and registry:runtime-events as complete arrays.

Several job paths read the full array, add one entity, sort it, and write the complete array back. The team registry is updated in multiple seed/discovery paths.

As the registry grows, inserting N teams by rewriting the full array for every new team produces O(N²) cumulative serialization and storage work.

Admin inventory also loads the arrays and filters/paginates in application memory rather than using an indexed query.

**Recommendation:** Use a SQLite table within the TaskScheduler Durable Object for registry entities and status. Add indexes for entity kind, year and seed state. Query pages with a cursor. Do not introduce D1; the existing SQLite-backed Durable Object is sufficient.

### P2-06 — TaskScheduler discovery pages are written sequentially and old generations are not collected

**File:** workers/fieldview-runtime/src/task-scheduler.ts

Published discovery snapshots use generation-specific pages and a pointer switch, which is a good atomic-publication pattern.

However, page writes are awaited sequentially, so they do not benefit from same-turn write coalescing. The previous published page generations are not deleted or pruned after the pointer switches.

**Recommendation:** Batch page writes in safe transaction/Promise.all groups, retain a short reader-safety window, and garbage-collect old generations after the new pointer is durable.

### P2-07 — Foreign provider records remain duplicated across canonical owners

**Files:** packages/domain/src/event.ts; packages/domain/src/team.ts; workers/fieldview-runtime/src/event-runtime.ts; workers/fieldview-runtime/src/team-runtime.ts

ADR-0016 explicitly identifies the remaining data-model mismatch:

- FieldViewEventState.teams still contains full team profiles, even though TeamRuntime owns team profiles.
- FieldViewTeamState.events still contains full event records, even though EventRuntime owns event records.

This duplicates foreign profile data in every relevant EventRuntime/TeamRuntime publication.

This is a known, documented migration target rather than an undocumented regression. It is nevertheless unfinished.

The good news is that FieldViewTeamEventState now stores match references rather than copying full match records. Preserve that direction.

**Recommendation:** Replace foreign full records with owner references plus a deliberately small display projection where required. Event pages already retrieve EventRuntime snapshots for team event sections, so the TeamRuntime event list can likely be reduced substantially. Avoid solving this with synchronous fan-out on public reads.

### P2-08 — Provider types still enter the client module graph

The confirmed imports are:

| Client-facing file/module | Provider type dependency |
|---|---|
| apps/web/src/components/insights/EventAnalyticsDashboard.tsx | Direct StatboticsTeamEvent and StatboticsTeamYear imports; also imports the legacy EventAnalyticsResponse contract. |
| apps/web/src/lib/insights/types.ts | StatboticsMatch, TBAEvent, TBAMatch, TBAEliminationAlliance and TBAEventRanking. |
| apps/web/src/lib/insights/canonical-dashboard-adapter.ts | StatboticsMatch, including an unsafe fabricated-object cast. |
| apps/web/src/lib/events/EventState.ts | StatboticsMatch and multiple TBA types in the legacy SharedWorker state model. |
| apps/web/src/lib/tba/buildStreams.ts | TBAWebcast, through a helper imported by client event/tile surfaces. |

These are type-level dependencies; they do not necessarily bundle provider runtime code. They still couple the frontend's contracts to provider schemas.

The domain package's own provider type imports are a separate matter: MIGRATION-PLAN principle 6 explicitly permits the domain to depend on provider packages for unchanged source fields. The direct UI imports above bypass that intended boundary.

The most problematic case is canonical-dashboard-adapter.ts, which constructs a compatibility object and casts it to StatboticsMatch using as unknown as. That makes the legacy dashboard appear to receive a real provider object even though the adapter has only constructed a subset.

**Recommendation:** Define FieldView dashboard/view-model contracts in the domain or analytics package. Make the adapter return those contracts, not fabricated provider DTOs. Migrate EventAnalyticsDashboard to canonical types and remove the legacy EventAnalyticsResponse contract.

### P2-09 — Provider payloads are not runtime-validated at the provider boundary

The provider packages generate TypeScript types, but TypeScript interfaces do not validate external JSON.

TBAApiClient returns a native Response. The Event and Team normalizers mostly attach FieldView metadata to provider objects; normalizeFieldViewEvent is effectively a spread, and normalizeFieldViewTeam only normalizes FRC Colors fields. The match normalizer assumes expected nested arrays/objects exist.

The serverSnapshot helpers also cast parsed JSON to FieldView types after checking only a small subset of fields such as key, event_key or team_key.

This means malformed or changed upstream payloads can pass the boundary and fail later in deeper normalization or rendering code.

**Recommendation:** Add runtime parsing/guards for the fields actually required by each canonical contract. Zod, Valibot or explicit small schema functions are suitable. Preserve the original provider payload separately where source fidelity is required; do not confuse source preservation with trusting the payload shape.

### P2-10 — Provider request deadlines and Retry-After handling are missing

TBAApiClient exposes only headers in its request options and does not provide a request signal/deadline option. The provider transports do not implement an explicit timeout.

The runtime has retry/backoff behavior, but no Retry-After handling was found for provider 429 responses.

**Recommendation:** Add an explicit request deadline using AbortSignal.timeout or equivalent, pass signals through the provider client, respect Retry-After for 429/503, and keep the existing durable retry/backoff state. Do not add a global mutex contrary to the current architecture decision.

### P2-11 — EventAnalyticsSurface contradicts its own empty-value semantics

**File:** apps/web/src/components/insights/EventAnalyticsSurface.tsx

The comment says explicit null/empty values are authoritative. The merge logic uses live.teams?.length and live.event_teams?.length to decide whether to accept the live arrays.

An explicit empty array is therefore treated as missing and replaced with the initial server snapshot. A genuinely empty live roster cannot clear the old roster.

**Recommendation:** Distinguish not-yet-loaded from loaded-empty. Use an explicit snapshot-loaded/status field or test undefined separately from an authoritative empty array.

### P2-12 — Completed event snapshots are fetched with no-store

**Files:** apps/web/src/lib/events/serverSnapshot.ts; apps/web/src/app/event/[event]/page.tsx; apps/web/src/app/team/[team]/page.tsx

getCanonicalEventSnapshot uses the default no-store fetch. EventPage therefore fetches the Worker on each server render, including completed historical events.

TeamPage fetches the event snapshot for each team event section with concurrency 4, but those event snapshots are also no-store. The concurrency limit is good; the absence of caching for completed events is not.

The project has an established goal of prerendering/caching completed event pages for approximately a day to reduce backend/API load. The current server snapshot helper does not implement that behavior.

**Recommendation:** Keep active events no-store or short-lived. Cache completed event snapshots/pages for at least a day, with a clear completion/retention rule and revalidation path.

### P2-13 — Team discovery is not cached like event discovery

**Files:** apps/web/src/lib/events/serverSnapshot.ts; apps/web/src/app/insights/page.tsx

getCanonicalEventDiscovery uses the Next.js Data Cache with a five-minute revalidation period. getCanonicalTeamDiscovery uses the default no-store behavior.

The Insights landing page downloads the full team discovery list only to display teams.length.

**Recommendation:** Give team discovery an equivalent short server cache and expose/use a count or summary response for the Insights landing page. Do not download thousands of team records merely to display a count.

### P2-14 — Server-side snapshot helpers log every fetch and parse

**File:** apps/web/src/lib/events/serverSnapshot.ts

fetchCanonicalRuntime and readCanonicalJson emit console.info on every fetch and every body parse. TeamPage may fetch one team snapshot plus several event snapshots, so one page render can generate many log records.

This is useful during prototype debugging but should be gated or sampled for production. The Worker config also currently samples logs at 100%.

**Recommendation:** Use structured sampling or an environment-controlled diagnostic level. Keep errors and slow requests visible; move high-volume counters/latency metrics to Analytics Engine.

### P2-15 — Dead district routes remain in the Worker entrypoint

**File:** workers/fieldview-runtime/src/index.ts

The entrypoint still forwards district discovery/snapshot paths to TaskScheduler. TaskScheduler no longer implements district query routes, and its tests assert that district queries are no longer exposed.

These routes therefore remain as dead public routing branches that return the TaskScheduler fallback/404.

**Recommendation:** Remove the stale district routes from the Worker entrypoint and add an entrypoint-level test that verifies the retired paths are not exposed. Team-owned district membership data is a separate concern and can remain.

## 6. Legacy architecture inventory

### Active or compatibility-reachable legacy paths

1. **Redis remote signaling:** apps/web/src/lib/remote/signalingServer.ts still uses Redis Pub/Sub and TTL-based presence. This is active remote-session infrastructure.
2. **Redis WSS bridge:** apps/web/src/lib/realtime/websocket.ts still uses Redis Pub/Sub to broadcast TBA updates to Vercel WebSocket clients.
3. **Dual webhook relay:** apps/web/src/app/api/tba/webhook/route.ts sends the signed request to EventRuntime and, after Worker success, also broadcasts to the legacy Redis WSS bridge.
4. **Legacy EventState:** apps/web/src/lib/events/EventState.ts remains in the SharedWorker and per-tab fallback paths. It uses provider-shaped types and the old subscription contract, although its API acquisition now goes through the current API routes.
5. **SharedWorker compatibility protocol:** eventState.shared-worker.ts still handles legacy subscribe/unsubscribe messages alongside canonical subscriptions.
6. **Legacy provider client/service modules:** apps/web/src/lib/tba/client.ts and service.ts, apps/web/src/lib/statbotics/client.ts, and apps/web/src/lib/frc-colors/client.ts remain. The current API routes reviewed now use canonical Worker helpers rather than these old clients. They appear to be retained compatibility/rollback material, but the migration plan itself says their complete import/runtime reachability has not been re-audited. Do not delete them until that audit is completed.
7. **Legacy analytics presentation:** EventAnalyticsDashboard, insights/types.ts and canonical-dashboard-adapter.ts retain the old response shape.
8. **EventScheduler naming alias:** event-scheduler.ts and the event-scheduler test filename remain after the class rename to TaskScheduler. This is likely compatibility residue, not a functional defect.

The ioredis dependency cannot be removed while remote signaling and the old WSS bridge still depend on it.

### What is no longer legacy provider acquisition

The current event/team API routes reviewed are Worker-backed compatibility adapters. The team matches route is now a thin canonical Worker proxy. The Statbotics match route reads EventRuntime data. The current EventPage and TeamPage use canonical snapshots and do not fall back to the old provider-shaped service path.

serverSnapshot.ts still contains comments claiming that a null canonical result leaves a legacy caller path available. EventPage and TeamPage do not implement such a fallback; they render unavailable/pending states. Those helper comments should be corrected.

## 7. Documentation mismatches

The following are not merely old documents; they contain statements that conflict with the current branch.

| Document | Mismatch |
|---|---|
| docs/architecture/MIGRATION-PLAN.md, M7 remaining-work list | Still says the team match-investigation endpoint must be migrated off the legacy Redis/provider path. The current route is already a thin Worker proxy. |
| docs/architecture/MIGRATION-PLAN.md, 2026-11-19 Team Investigation note | Says the Worker aggregation is not yet a durable season analytics publication. TeamRuntime now persists team-season-analytics:{year}, checks revisions and serves the cached publication. Mark the earlier note superseded. |
| docs/architecture/MIGRATION-PLAN.md, 2026-11-18 TeamRuntime slice | Says public reads never schedule provider acquisition and at most one provider request runs per alarm. Current code queues stale revalidation from public reads and runs independent due resources concurrently. Later decisions supersede this, but the old text is not marked as superseded. |
| docs/architecture/SEASON-INGEST.md | Describes a shared single-flight/global provider request lease. The 2026-11-20 runtime ownership decision and current code explicitly reject a global provider mutex. |
| docs/development/FIELDVIEW-RUNTIME.md | Still describes district query routes and legacy insights API compatibility redirects that are not present in the current route inventory. |
| docs/architecture/MIGRATION-PLAN.md, district status | Says district routes are retired, but Worker index.ts still forwards district paths to TaskScheduler. |
| docs/architecture/decisions/ADR-0014 | TaskScheduler is not supposed to proxy provider requests for entity-owned resources. Its event-team seed path directly requests the EventRuntime-owned eventTeams endpoint. |
| docs/architecture/decisions/ADR-0015 | Requires broader activation hydration of endpoint metadata, local task state and publications. EventRuntime currently hydrates identity and EventState publication; other durable state is read lazily. Either implement the full checklist or explicitly revise the ADR to describe the storage-backed lazy-read strategy. |
| docs/analytics/CALCULATION-AUDITABILITY.md | Still describes the Next.js progressive analytics service as the current season-comparison/dashboard path. That service has been removed from the current implementation. |
| docs/ARCHITECTURE.md | Dated 2026-11-10 and still describes the old Redis/EventState architecture as current. Label it historical or rewrite it as the current architecture. |
| docs/architecture/MIGRATION-INVENTORY.md | Is a pre-migration baseline, but its later “current implementation status” language is now false. Label the entire document as a baseline snapshot. |
| apps/web/src/lib/events/serverSnapshot.ts | Comments say callers retain a legacy path when canonical reads return null; EventPage and TeamPage do not. |

ADR-0016 is comparatively honest: it explicitly identifies the remaining mismatch between canonical ownership and the current TypeScript/persisted foreign records. Keep that status visible until the normalization is complete.

## 8. Cloudflare platform review

The current architecture already uses several appropriate Cloudflare primitives: one Durable Object per event/team, Durable Object alarms, SQLite-backed Durable Object classes, and WebSocket hibernation. I would not replace that architecture with D1 or a general-purpose database.

There are, however, several platform capabilities that the current code is not using.

### 8.1 Durable Object SQLite SQL API — high value

The Wrangler migrations declare SQLite-backed Durable Object classes, but the runtime storage abstraction exposes only asynchronous get/put/list/delete/transaction operations. No storage.sql.exec or transactionSync usage was found.

Use SQL tables within TaskScheduler for:

- Team/event/runtime registries.
- Entity status and seed state.
- Job indexes and cursors.
- Webhook dedupe metadata.
- Provider source-version metadata and archive pointers.

Keep the latest canonical payloads as JSON values where that is the simplest representation. SQL is most valuable for structured indexes and mutable metadata, not for turning every provider payload into many tiny rows.

Cloudflare references:
- [SQLite Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Object best practices](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)

The same best-practices documentation describes write coalescing: multiple writes issued without an intervening await can be batched. TaskScheduler's sequential awaited page-write loop does not take advantage of that behavior.

### 8.2 Durable Object RPC — high value

Internal EventRuntime/TeamRuntime/TaskScheduler calls are currently expressed as HTTP Request/Response objects with manually constructed paths, JSON bodies and status handling.

The configured compatibility date is 2026-11-17, well beyond the compatibility date at which Durable Object RPC is available.

Use typed RPC methods for internal operations such as:

- EventRuntime asking TeamRuntime to calculate/read a team event state.
- TeamRuntime notifying EventRuntime of a changed team revision.
- TaskScheduler asking EventRuntime for participant keys.
- TaskScheduler issuing seed/refresh commands.

Keep fetch for public Worker HTTP endpoints and webhook ingress. RPC would remove a substantial amount of internal route parsing and JSON envelope code, and make method contracts explicit.

Reference:
- [Create Durable Object stubs and send requests](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)

### 8.3 R2 — high value for immutable history

R2 is a better fit than unbounded Durable Object key/value records for full provider response history and optional raw webhook archives.

Keep the current source revision, hash, timestamp and R2 object key in EventRuntime. Apply lifecycle/retention rules to archived objects.

Reference:
- [Cloudflare R2](https://developers.cloudflare.com/r2/)

### 8.4 Queues — useful for durable fan-out and retry

Queues can decouple team-to-event notifications and webhook-triggered downstream work from the initiating Durable Object request.

A Queue consumer can have configured concurrency, batching, retries and a dead-letter queue. This is a natural improvement for the current notification path that silently ignores non-2xx responses.

Queues provide at-least-once delivery, not exactly-once delivery. Keep the current revision/idempotency checks and make consumers safe to retry.

Do not move canonical state into Queues; EventRuntime and TeamRuntime remain the owners.

References:
- [Queue consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)
- [Queue batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)

### 8.5 Workflows — evaluate for bulk ingestion, not ordinary polling

TaskScheduler is a large custom durable job state machine covering discovery, season ingestion, team seeding, event-team seeding and coverage work.

Cloudflare Workflows can manage durable multi-step execution, sleeps, retries and step state. It is worth prototyping for long-running administrative backfills and season-ingest jobs.

It is not a drop-in replacement for the per-event/per-team recurring alarms. Also, Workflows has per-instance step and state limits; the documented maximum step count is 25,000. A full-season job may need to be split into event/team batches rather than represented by one enormous workflow.

References:
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
- [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/)

### 8.6 Analytics Engine — high value for runtime observability

The current code logs many operations, but it does not have a structured time-series view of resource use.

Use Analytics Engine for non-blocking metrics such as:

- Provider requests by provider, endpoint and status.
- 200/304/429/5xx ratios.
- Poll duration and retry delay.
- Durable Object notification counts and failure rates.
- Event analytics fan-out size and duration.
- Publication age and stale-read rate.
- Season-ingest job duration and backlog.
- Approximate payload/archive size and source-version count.

This would make the storage and request amplification identified in this audit measurable.

Reference:
- [Cloudflare Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)

### 8.7 Workers KV or Cache API — use only for read-only projections

The TaskScheduler is a global Durable Object serving discovery projections. Event and team discovery are slower-changing than live event state.

A versioned, read-only event/team discovery projection in Workers KV or the Cache API could reduce pressure on the global TaskScheduler and serve list pages at the edge.

Workers KV is eventually consistent. Do not use it as the canonical owner of event/team state, webhook reconciliation or revision coordination. It is suitable for published discovery snapshots where a short period of staleness is acceptable.

Reference:
- [How Workers KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

### 8.8 Existing good Cloudflare choices

- Per-event and per-team Durable Objects are appropriate ownership boundaries.
- Durable Object alarms are appropriate for entity-local recurring polling.
- WebSocket hibernation is already used by Multiplexer; keep it.
- The code uses activation barriers only for bounded startup hydration rather than holding them around network calls.
- The project does not need D1 to achieve its current ownership model.

### 8.9 Global Durable Object hotspots

TaskScheduler uses a single global object ID and Multiplexer uses a single shared object ID.

Cloudflare documents a soft per-object request-rate limit around 1,000 requests/second. The global multiplexer is the more likely hotspot because it handles all live client subscriptions and notifications. This is not an immediate problem proven by current traffic, but it is a scaling boundary.

If measured load approaches the limit, shard Multiplexer by event or subscription partition. Consider edge caching for discovery before sharding TaskScheduler.

Reference:
- [Durable Object platform limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

### 8.10 Logging configuration

The production-oriented wrangler.toml sets log head_sampling_rate to 1 (100%) and trace sampling to 0.1. It does not enable source map upload.

For production, use structured sampled logs plus Analytics Engine metrics, and enable source maps so TypeScript stack traces are actionable.

Reference:
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)

## 9. Other structural and repository issues

### Large monolithic files

The largest critical source files are:

- TaskScheduler: approximately 2,333 lines.
- EventRuntime: approximately 2,265 lines.
- TeamRuntime: approximately 1,283 lines.
- EventAnalyticsDashboard: approximately 1,817 lines.

These files mix routing, storage, scheduling, provider acquisition, analytics composition and diagnostics. They are difficult to review and make failure boundaries harder to test.

Split logic into modules while preserving the Durable Object ownership boundary. For example: endpoint polling, webhook reconciliation, publication, analytics coordination, notifications and route handlers.

### Committed logs

The two logs/HAR artifacts dominate repository size. Remove them from the source branch after preserving them in an appropriate private artifact location. Add logs/HAR files to .gitignore. Run a local secret scan before considering them safe; their content was not available to this audit.

### No full production cutover validation

The prototype Worker has been manually exercised, but the migration plan says the deployed prototype predates the latest branch changes. Current HEAD has no successful CI run. There is no evidence here of a production Worker route, production mirror setting, production admin authorization or production frontend cutover.

## 10. Recommended remediation order

### Phase A — release safety

1. Get a successful CI run on the exact current HEAD.
2. Add Next.js production build and Wrangler dry-run to blocking CI.
3. Include the FRC Colors provider test and explicit provider workspace typechecks.
4. Confirm the production Statbotics base URL.
5. Keep prototype RUNTIME_ADMIN_TOKEN out of production and implement the real admin authorization model.
6. Keep production routing disabled until the above checks pass.

### Phase B — stop avoidable storage growth

1. Stop writing full endpoint payloads on 304.
2. Store providerData only where reconciliation requires it.
3. Separate TeamRuntime analytics checkedAt from the large cached response.
4. Stop TeamRuntime from republishing/notifying on freshness-only changes.
5. Compact webhook dedupe records and establish retention.
6. Move immutable provider versions to R2 or give them a bounded, queryable retention policy.
7. Garbage-collect old TaskScheduler discovery page generations.
8. Replace full registry arrays with SQLite tables.

### Phase C — make cross-object work reliable and smaller

1. Make TeamRuntime-to-EventRuntime notification status-aware and durably retryable.
2. Make event analytics fan-out partial and per-team fault-isolated.
3. Return TeamEventState from the event-analytics command instead of making a second GET.
4. Send compact team-specific analytics inputs instead of the entire event state to every team.
5. Remove TaskScheduler's direct eventTeams provider request; ask EventRuntime for participant keys.
6. Add bounded concurrency for large fan-outs.

### Phase D — complete the canonical frontend boundary

1. Remove provider type imports from EventAnalyticsDashboard and its client dependency graph.
2. Replace the fabricated StatboticsMatch compatibility object with a FieldView dashboard DTO.
3. Fix EventAnalyticsSurface empty-array semantics.
4. Add completed-event snapshot caching and team discovery caching.
5. Add a count/summary response for the Insights landing page.
6. Correct serverSnapshot fallback comments and reduce per-request diagnostic logging.

### Phase E — close migration/documentation debt

1. Update MIGRATION-PLAN's stale team-match, durable-cache and request-concurrency sections.
2. Reconcile SEASON-INGEST.md with the current no-global-mutex decision.
3. Update FIELDVIEW-RUNTIME.md's district and legacy insights route descriptions.
4. Update CALCULATION-AUDITABILITY.md and ARCHITECTURE.md.
5. Mark MIGRATION-INVENTORY.md as a pre-migration baseline.
6. Complete the import/reachability audit for old provider clients.
7. Migrate remote signaling and legacy Redis WSS separately; do not remove ioredis until those consumers are gone.
8. Complete ADR-0016 foreign-record normalization and ADR-0015 hydration/readiness decision.

## 11. Positive implementation patterns to preserve

This branch has several strong decisions that should not be undone:

- EventRuntime and TeamRuntime are the owners of their respective event/team data.
- Public reads return persisted publications and queue stale revalidation rather than doing provider I/O inline.
- ETag/304 support and revision checks prevent unnecessary provider payload replacement.
- Webhook reconciliation preserves upstream providerData separately from accepted webhook changes where that distinction matters.
- TBA webhook ingress verifies the signed request in the Worker and uses an idempotency key.
- TeamEventState stores references to EventRuntime-owned match records.
- EventRuntime no longer embeds duplicated TeamRuntime state publications.
- TeamRuntime's event page fetches use a concurrency limit of four rather than unbounded Promise.all.
- TaskScheduler jobs are durable/resumable and have explicit progress state.
- The current architecture decision correctly avoids a single global provider mutex.
- Worker tests cover many important state transitions and failure cases.

The goal should be to improve persistence, failure handling and payload boundaries without undoing these ownership decisions.

## 12. Final verdict

**Do not treat this branch as production-ready yet.**

The core architecture is substantially better than the previous baseline. The remaining blockers are concentrated and actionable:

- storage growth and write amplification,
- lost cross-object notifications,
- all-or-nothing event analytics fan-out,
- oversized repeated analytics payloads,
- incomplete provider ownership,
- incomplete production configuration and validation,
- and stale documentation.

The highest-value immediate work is not another broad refactor. It is to fix the P1 findings, measure storage/request behavior with Analytics Engine, then reduce redundant writes and cross-object calls.

