# Full-season ingestion

## Status

Design contract only. The admin command center does not yet expose or execute a full-season ingest. The full-season coverage audit is implemented separately and does not make provider requests. Do not use the existing per-team `seed` action as a substitute: it synchronously refreshes a team and fans out scheduling work to every event associated with that team. Likewise, the current event single-resource refresh path can invoke the EventRuntime alarm, which may process other due resources; it is not a safe primitive for a globally paced ingest job. Before enabling ingestion, add isolated one-resource execution to both runtime types and a shared request gate that normal EventRuntime and TeamRuntime alarms also honor. Otherwise normal polling could overlap the season job and invalidate its advertised global request interval.

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

The admin command center exposes a preview and explicit start/pause/resume/cancel controls. The Worker persists each year's job under the EventScheduler Durable Object and advances it from alarms, one entity at a time:

1. Prepare every discovered season team through its TeamRuntime `/refresh` route. This intentionally bypasses the index-level `seed` operation, which fans out to event runtimes.
2. For every discovered event, refresh its provider resources, request a canonical snapshot so EventRuntime persists EventState, then request analytics calculation and verify the EventAnalytics publication.
3. Persist phase cursors and separate complete/partial/failed counters. A Worker restart resumes from the last durable cursor; a retried completed-with-errors job restarts its inventory scan and skips already-acquired TeamRuntime resources and already-complete EventState artifacts.
4. Record bounded recent errors and continue processing other entities when one entity fails. Partial evidence is counted distinctly from missing or failed artifacts.

The job starts only after a preview confirms complete event and paginated team discovery, and the start operation requires an explicit confirmation flag. Each alarm step processes at most one team or event; it does not fan out the full inventory in one request. The job shares the EventScheduler alarm with routine discovery, so routine scheduler work is deferred while a season-ingest job is actively running and resumes afterward if enabled.

## Completion and coverage accounting

The season job and coverage audit must report distinct counts for:

- Events in the discovered inventory.
- EventState publications complete, partial, missing, and failed.
- EventAnalytics publications succeeded, partial, missing, waiting for cohort, and failed.
- TeamRuntime season snapshots complete, partial, missing, and failed.
- Events whose participant cohort is complete, partial, or still discovering.

The job is complete only when every discovered event has an EventState publication and an EventAnalytics publication, with partial outcomes explicitly accounted for. A terminal job may contain recorded failures, but it must never report full success while any event artifact is missing or failed.

## Safety requirements

1. **Preview before start.** Resolve and retain the selected year's discovery snapshots, then show event count, team count, resource-request estimate, expected duration at the selected rate, and any already-complete work.
2. **One external resource request at a time.** Do not use unbounded `Promise.all`, bulk team seeding, or event fan-out to execute the season job.
3. **Explicit global pacing.** The job owns a durable next-request timestamp and a configurable request interval. The scheduler must honor the interval across TBA, Statbotics, and FRC Colors calls.
4. **Durable progress.** Persist year, discovery snapshot identity, current phase, event/team index, resource index, completed/failed/skipped counts, request count, next due time, and recent errors. A Worker restart must not lose the cursor.
5. **Pause, resume, cancel.** Pausing prevents new provider requests but preserves progress. Resume continues from the cursor. Cancellation is terminal and must not erase the audit record.
6. **Bounded retry.** Retry transient failures with capped backoff and a finite attempt count. Permanent failures are recorded and skipped; they must not stall the entire season indefinitely.
7. **Idempotency and reuse.** Skip resources already current for the selected discovery version unless the operator explicitly chooses a force-refresh mode. Never discard previously acquired source data when a request fails.
8. **Request accounting.** Distinguish planned, attempted, successful, failed, retried, and skipped requests. The estimate is a lower-bound planning figure; retries and unrelated normal polling are reported separately.
9. **No production cutover.** A season job is an ingestion/refresh operation, not permission to change runtime routing, deploy, or alter production configuration.

## Request estimate

The current configured resource sets contain 12 TBA event resources plus one Statbotics event-match resource per event, and seven resources per team. The initial planned-request estimate is therefore:

`event_count × 13 + team_count × 7`

The preview must derive counts from the actual configured resource builders rather than hard-code this formula as an execution limit. It must disclose that retries, refreshes caused by normal polling, and future resource additions can increase actual provider traffic.

## Runtime ownership

The global EventScheduler Durable Object is the natural owner for the durable job cursor and single-flight pacing because it already owns event/team discovery caches and the alarm. Job alarms must not cause normal discovery to run on every ingest tick: routine discovery needs its own due timestamp, independent of the ingest next-request timestamp. The season job must continue to run when routine discovery is stopped, while never changing that scheduler's enabled state.

The admin Worker route is the only mutation entry point. The Next.js admin API authenticates the dashboard token and forwards the server-only runtime token; the browser never receives the Worker token.

## Admin UI

The season-ingest view should require these distinct steps:

1. Select a year and request a preview.
2. Review the discovered event/team totals, resource estimate, request interval, and duration.
3. Explicitly confirm and start.
4. Monitor progress and request accounting; pause, resume, or cancel as needed.

The start action must not be available from a single click on the overview. A running job must be visible on the overview and in the system operations view.
