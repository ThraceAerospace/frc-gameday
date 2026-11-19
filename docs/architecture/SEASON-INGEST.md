# Full-season ingestion

## Status

The admin command center now exposes a preview and durable season-ingest job. The job is intentionally paced at the individual provider-resource level. It does not use the existing per-team `seed` action, which fans out scheduling work to every event associated with that team, and it does not use bulk `refresh` as its ingestion primitive.

EventRuntime and TeamRuntime both expose authenticated one-resource ingestion routes. Their normal alarms and the season job acquire a lease from the global EventScheduler provider-request gate before making a provider request. The lease is single-flight, expires after 60 seconds if a Worker is interrupted, and enforces the configured interval after release. The default interval is 1000 ms and is configurable through `PROVIDER_REQUEST_INTERVAL_MS`. While a season job is running, routine EventScheduler discovery is deferred; explicit discovery refreshes are rejected while a job is running or paused.

## Scope

A season ingest is a deliberate, resumable operation for one TBA competition year. It covers:

- Every event returned by TBA event discovery for the selected year.
- Every team returned by TBA team discovery for the selected year.
- Every configured event resource, including the Statbotics event-match resource.
- Every configured team resource for that year, including TBA, Statbotics, and FRC Colors resources.
- Canonical event analytics only after season-wide team preparation and each event's participant cohort prerequisites are satisfied.

The operation must not create a Cartesian product of every team and every event. Team-season records and event participant relationships are ingested through their owning event/team resources.

## Required execution order

The season output is two independently verifiable canonical artifacts for **every discovered event**:

- **EventState**: the canonical event snapshot assembled from that event's acquired TBA and Statbotics resources. Persist the generated state (or a versioned state publication) in the owning EventRuntime so completion survives Worker restarts and can be audited without rebuilding it on every read.
- **EventAnalytics**: the canonical analytics publication calculated from the persisted EventState plus the validated season-wide participant cohort. Persist its source revision, analytics revision, calculation time, status, and any partial/unavailable-input diagnostics.

An EventRuntime registration, a set of raw endpoint records, or a successful HTTP response from a refresh command is not proof that either artifact was generated. Track EventState and EventAnalytics generation status independently for every event. A partial state or analytics result must be explicitly labeled partial; failed or unavailable inputs must remain visible and must never be silently counted as complete.

1. **Complete discovery.** Fetch the full event list and every TBA season-team page (500 teams per page) until a short final page proves pagination is complete. Never interpret a missing or empty team page cache as a zero-team season.
2. **Prepare every season team.** Acquire the configured TeamRuntime resources for every team returned by the year-scoped TBA team list. This makes team event histories and Statbotics team-event evidence available to construct event comparison cohorts.
3. **Acquire event inputs and publish EventState.** Acquire the configured resources for every event, including its authoritative participant list. Build and persist that event's canonical EventState from the acquired resources. Record `complete`, `partial`, or `failed` state-generation status and its source revision. Do this for every event in the discovered inventory, including historical, offseason, and upcoming events; do not restrict the job to events with currently active polling lifecycles.
4. **Build and validate event cohorts.** For each event, construct the cohort from all of that event's participants using their prepared TeamRuntime season snapshots. Preserve missing or unavailable evidence as explicit cohort rows; do not silently omit teams.
5. **Calculate and publish EventAnalytics.** Do not publish event analytics while a participant's TeamRuntime season event history is still undiscovered. Missing Statbotics values may remain explicit partial evidence, but the participant roster/history prerequisite must be met first. Generate analytics for every event with a usable EventState and cohort; persist `succeeded`, `partial`, `waiting-for-cohort`, or `failed` status plus source and analytics revisions. A failed event must not block other events from progressing.

EventRuntime now withholds analytics calculation while its participant cohort is still in the discovering state. The season ingest must perform the team-preparation phase first so this gate can clear predictably rather than relying on repeated event-runtime retries.

## Durable season-ingest job

The admin command center exposes a preview and explicit start/pause/resume/cancel controls. The Worker persists each year's job under the EventScheduler Durable Object and advances it from alarms, one provider resource at a time:

1. Prepare every discovered season team by walking its seven configured TeamRuntime resources individually through `/ingest-resource`.
2. For every discovered event, walk all configured TBA and Statbotics resources individually, then request a canonical snapshot so EventRuntime persists EventState, request analytics calculation, and verify the EventAnalytics publication.
3. Persist the discovery snapshot timestamps, phase cursors, per-entity resource cursors, retry count, next due time, and separate complete/partial/failed counters. A Worker restart resumes from the last durable cursor; a retried completed-with-errors job restarts its inventory scan and skips already-acquired resources and already-published complete artifacts.
4. Record bounded recent errors and continue processing other entities when one resource fails. Partial evidence is counted distinctly from missing or failed artifacts.

The job starts only after a preview confirms complete event and paginated team discovery, and the start operation requires an explicit confirmation flag. Each alarm step processes at most one provider resource; it does not fan out the full inventory in one request. The job shares the EventScheduler alarm with routine discovery, so routine scheduler work is deferred while a season-ingest job is actively running and resumes afterward if enabled.

## Completion and coverage accounting

The coverage audit must report distinct counts for:

- Events in the discovered inventory.
- EventState publications complete, partial, missing, and failed.
- EventAnalytics publications succeeded, partial, missing, waiting for cohort, and failed.
- TeamRuntime season snapshots complete, partial, missing, and failed.
- Events whose participant cohort is complete, partial, discovering, or missing.

The season job must separately report TeamRuntime snapshots complete, partial, and failed; per-event EventState complete, partial, missing, and failed; per-event EventAnalytics succeeded, partial, missing, waiting-for-cohort, and failed; cohort outcomes; and provider request attempted, succeeded, failed, retried, skipped, unavailable, and deferred counts.

The job reports full success only when every discovered event has a complete EventState, successful EventAnalytics, and a complete participant cohort, with all season TeamRuntime snapshots complete. Partial, waiting, missing, or failed outcomes produce a completed-with-errors result and remain separately counted.

## Safety requirements

1. **Preview before start.** Resolve and retain the selected year's discovery snapshots, then show event count, team count, resource-request estimate, expected duration at the selected rate, and any existing job state.
2. **One external resource request at a time.** Do not use unbounded `Promise.all`, bulk team seeding, or event fan-out to execute the season job. Each EventRuntime and TeamRuntime provider call, including normal alarm-driven polling, must acquire the shared single-flight lease.
3. **Explicit global pacing.** The EventScheduler gate owns a durable lease and next-request timestamp and enforces the configurable interval across TBA, Statbotics, and FRC Colors calls. A lease expires after 60 seconds if the Worker is interrupted.
4. **Durable progress.** Persist year, event/team discovery snapshot timestamps and inventory keys, current phase, event/team index, resource index, bounded retry count, completed/failed/skipped counts, attempted/succeeded/failed/deferred request counts, next due time, and recent errors. A Worker restart must not lose the cursor.
5. **Pause, resume, cancel.** Pausing prevents new season-job resource requests but preserves progress; normal live polling may continue and remains subject to the shared gate. Resume continues from the cursor. Cancellation is terminal and must not erase the audit record.
6. **Bounded retry.** Retry transient failures with capped backoff and a finite attempt count. Permanent failures are recorded and skipped; they must not stall the entire season indefinitely.
7. **Idempotency and reuse.** Skip resources already acquired for the selected season unless the operator explicitly chooses a future force-refresh mode. Completed EventState and EventAnalytics publications are reused on retry. Never discard previously acquired source data when a request fails.
8. **Request accounting.** Distinguish planned, attempted, successful, failed, retried, and skipped requests. The estimate assumes one request for every configured resource; cached resources reduce actual work, while retries and unrelated normal polling are reported separately.
9. **No production cutover.** A season job is an ingestion/refresh operation, not permission to change runtime routing, deploy, or alter production configuration.

## Request estimate

The current configured resource sets contain 12 TBA event resources plus one Statbotics event-match resource per event, and seven resources per team. The initial planned-request estimate is therefore:

`event_count × 13 + team_count × 7`

The preview must derive counts from the actual configured resource builders rather than hard-code this formula as an execution limit. It must disclose that retries, refreshes caused by normal polling, and future resource additions can increase actual provider traffic.

## Runtime ownership

The global EventScheduler Durable Object owns the durable job cursor, discovery snapshot references, alarm, and provider-request lease. Job alarms do not cause normal discovery to run on every ingest tick: routine discovery is deferred while the job is running and resumes afterward if enabled. The season job continues to run when routine discovery is stopped, without changing that scheduler's enabled state. EventRuntime and TeamRuntime alarms also honor the same lease, so live polling cannot overlap a season-job provider request.

The admin Worker route is the only mutation entry point. The Next.js admin API authenticates the dashboard token and forwards the server-only runtime token; the browser never receives the Worker token.

## Admin UI

The season-ingest view should require these distinct steps:

1. Select a year and request a preview.
2. Review the discovered event/team totals, resource estimate derived from the configured resource builders, shared request interval, and baseline duration estimate.
3. Explicitly confirm and start.
4. Monitor progress and request accounting; pause, resume, or cancel as needed.

The start action must not be available from a single click on the overview. A running job must be visible on the overview and in the system operations view.
