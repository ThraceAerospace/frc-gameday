# Full-season ingestion

## Status

Design contract only. The admin command center does not yet expose or execute a full-season ingest. The full-season coverage audit is implemented separately and does not make provider requests. Do not use the existing per-team `seed` action as a substitute: it synchronously refreshes a team and fans out scheduling work to every event associated with that team. Likewise, the current event single-resource refresh path can invoke the EventRuntime alarm, which may process other due resources; it is not a safe primitive for a globally paced ingest job. Before enabling ingestion, add isolated one-resource execution to both runtime types and a shared request gate that normal EventRuntime and TeamRuntime alarms also honor. Otherwise normal polling could overlap the season job and invalidate its advertised global request interval.

## Scope

A season ingest is a deliberate, resumable operation for one TBA competition year. It covers:

- Every event returned by TBA event discovery for the selected year.
- Every team returned by TBA team discovery for the selected year.
- Every configured event resource, including the Statbotics event-match resource.
- Every configured team resource for that year, including TBA, Statbotics, and FRC Colors resources.
- Canonical event analytics after the required event inputs have been acquired.

The operation must not create a Cartesian product of every team and every event. Team-season records and event participant relationships are ingested through their owning event/team resources.

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
