# Central polling coordinator

- **Status:** Implemented in the architecture-migration branch; not deployed
- **Date:** 2026-11-25
- **Scope:** FieldView recurring event and event-participant TeamRuntime refresh

## Ownership

The consolidated `runtime` Worker owns the recurring polling trigger. Its five-minute production Cron Trigger starts a `PollingCoordinatorWorkflow`; a separate 04:02 UTC daily Cron run enables the TeamRuntime freshness pass. Cron Triggers do not invoke Preview deployments, and Previews deliberately do not bind to the production Workflow. The Workflow is the only recurring polling coordinator; EventRuntime and TeamRuntime do not schedule alarms, recurring tasks, retries, or deferred provider work.

The coordinator selects targets and decides whether a refresh is due. It does not fetch provider endpoints, reconcile responses, or write canonical state. It sends explicit commands through the existing runtime dispatch contract. The target runtime performs provider acquisition, conditional requests, reconciliation, persistence, and publication.

## Target selection

Each run reads:
- `discovery/current-season.json`, which is authoritative from TBA `/status.current_season`;
- the published `projections/events/this-week/current.json` pointer and its immutable weekly event projection;
- the registered EventRuntime and TeamRuntime identity markers. It checks only identities in the current-week event projection and each refreshed event roster; it does not list or scan the full runtime registry.

The projection must be no more than eight days old. A missing or stale projection fails the run rather than scanning the full season or activating runtimes. Only registered events in the current season whose event-local lifecycle is active are candidates. Upcoming, completed, and expired events are excluded from recurring live polling. Any future pre-event refresh policy must be separately specified, explicitly budgeted, and independently enabled.

The event-local timezone is used by the shared lifecycle classifier; the coordinator does not infer event dates from the Worker timezone.

## Refresh decisions and dispatch

For each candidate, the coordinator calls EventRuntime readiness with `EVENT_ACTIVE_INTERVAL_MS` (default five minutes).

EventRuntime readiness remains read-only. The supplied minimum interval prevents an endpoint whose TTL is shorter than the lifecycle interval from being refreshed too frequently and rate-limits retries after failed/stale attempts. A never-attempted missing resource remains immediately eligible. If refresh is required, the coordinator sends one explicit EventRuntime refresh command containing only the stale endpoint list returned by readiness. If the publication is invalid but no individual source is stale, it requests the full owned resource set to rebuild the publication.

The daily 04:02 UTC pass asks EventRuntime for the participant roster of each active event. EventRuntime owns that TBA resource and may acquire it in response to this explicit command. The coordinator unions the rosters, filters to already registered TeamRuntimes, checks their readiness, and explicitly refreshes only teams reporting stale/missing resources. Team readiness and refresh fan-out are bounded to four concurrent calls. Live five-minute event ticks do not repeatedly inspect every participant TeamRuntime, and unregistered teams are never initialized by polling.

The initial TeamRuntime pass is daily and limited to the union of participants in current-week events. It does not yet implement a separate all-season TeamRuntime sweep or a fine-grained changed-match-to-team diff. Those require their own bounded selection policy and are intentionally not approximated by activating every team in the season.

## Cost and failure behavior

- Cron cadence is five minutes; event-level eligibility is governed by the lifecycle interval and runtime source freshness.
- Only the published current-week event projection is scanned; the full season directory and all team discovery records are not scanned on every tick.
- Runtime refresh concurrency is bounded; no Cloudflare Queue or Durable Object alarm is introduced.
- Workflow steps retain execution progress. Per-event failures are recorded in the Workflow result and do not prevent later candidates from being considered.
- If the weekly projection is unavailable or stale, the run fails closed. Run event discovery/readiness to republish it.
- The coordinator has not been deployed or exercised against live Cloudflare bindings as part of this source change. Hard per-run and account-wide provider/write budgets, the canonical Monday-to-Sunday `events-this-week` projection, and changed-match-to-team target derivation remain incomplete; the current daily team pass is not a substitute for those capabilities.
