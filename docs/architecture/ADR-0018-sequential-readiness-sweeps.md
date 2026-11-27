# ADR-0018: Sequential readiness sweeps and publication-gated reads

> The publication-gated read requirements in this ADR remain in force. Its DiscoveryStore ownership, randomized per-runtime queue/alarm scheduling, and readiness-triggered refresh provisions are superseded by [`decisions/2026-11-24-storage-and-polling-ownership.md`](decisions/2026-11-24-storage-and-polling-ownership.md). Readiness now inspects coverage only; the polling coordinator owns lifecycle scheduling and direct bounded refresh dispatch.

- **Status:** Partially superseded by the accepted 2026-11-24 storage and polling decision
- **Date:** 2026-11-22
- **Supersedes:** The stale-read initialization behavior in ADR-0015 where it conflicts with the publication gate below
- **Related:** ADR-0014, ADR-0015, ADR-0017

## Context

The previous daily readiness Workflow initialized event runtimes in batches by dispatching lifecycle operations. Each lifecycle operation could arm immediate resource polling. At the start of a season, hundreds of events have no persisted EventState, so this creates a concentrated wave of Durable Object alarms and provider requests. Local Workerd testing exposed CPU pressure and request timeouts while that work was being scheduled and executed.

The frontend must not wait for an entity to be initialized, nor should a public read become an implicit initialization command. A runtime existing is not equivalent to its canonical state being ready.

## Decision

1. Keep one deployed FieldView Worker per environment. Daily readiness and polling coordination are modules within that Worker, not separate Worker deployments.
2. Resolve the TBA current season and acquire/publish event/team discovery directories through the D1-backed Discovery repository. Workflow execution history belongs to the separate System Records repository.
3. Iterate current-season event keys sequentially and inspect each registered EventRuntime's read-time EventState projection from provider endpoint records and source freshness. Readiness reports missing/invalid publications and stale sources; it does not enqueue or dispatch provider refreshes.
4. Iterate current-season team keys sequentially and apply the same inspection-only check to TeamRuntime and its TeamState resources. Event readiness and Team readiness remain independent Workflows with separate progress and concurrency boundaries.
5. The polling coordinator, not readiness Workflows, evaluates event lifecycle at dispatch time using each event's timezone. It selects eligible EventRuntime instances and only the affected TeamRuntime instances, then issues explicit direct refresh commands with bounded concurrency. It does not fetch provider resources.
6. EventRuntime and TeamRuntime implement the same runtime refresh contract at different data scopes. Each runtime fetches its own provider resources, applies conditional validators, reconciles against its latest working state, persists meaningful canonical changes, and publishes versioned outputs.
7. A Queue and per-runtime recurring polling alarms are not part of the default target architecture. Existing queue/alarm code is transitional and may be removed only after every recurring poll, webhook follow-up, retry, analytics dependency, and recovery path has an explicit coordinator-owned replacement.
8. Frontend-facing event/team state reads return HTTP 404 until a valid canonical publication exists. Public reads do not create identities, initialize state, queue provider work, or synthesize placeholder state. Once a valid publication exists, reads return that persisted publication, including stale last-good data. Failed refreshes never erase it.
9. Schedule the daily readiness Workflow at 10:00 UTC so the coverage sweep begins before typical US morning usage. This schedule does not control live polling.

## Consequences

- The daily readiness Workflow is intentionally sequential and may take longer to finish. It inspects coverage and does not generate provider traffic.
- The polling coordinator enforces the live polling budget through explicit bounded dispatch; randomized per-runtime alarm deadlines are not the concurrency model.
- A newly discovered entity may remain unavailable (404) until its first durable canonical publication is generated.
- Stale but previously published state remains readable while a refresh runs; missing state is not represented as an empty or partial placeholder.
- EventRuntime and TeamRuntime remain responsible for their own acquisition, reconciliation, retry behavior, persistence, and publication. The polling coordinator selects targets and dispatches commands.
- This decision does not introduce a global TaskScheduler Durable Object or global provider lease, or additional Worker deployment.
