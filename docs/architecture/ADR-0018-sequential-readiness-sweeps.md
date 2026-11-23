# ADR-0018: Sequential readiness sweeps and publication-gated reads

- **Status:** Accepted
- **Date:** 2026-11-22
- **Supersedes:** The stale-read initialization behavior in ADR-0015 where it conflicts with the publication gate below
- **Related:** ADR-0014, ADR-0015, ADR-0017

## Context

The previous daily readiness Workflow initialized event runtimes in batches by dispatching lifecycle operations. Each lifecycle operation could arm immediate resource polling. At the start of a season, hundreds of events have no persisted EventState, so this creates a concentrated wave of Durable Object alarms and provider requests. Local Workerd testing exposed CPU pressure and request timeouts while that work was being scheduled and executed.

The frontend must not wait for an entity to be initialized, nor should a public read become an implicit initialization command. A runtime existing is not equivalent to its canonical state being ready.

## Decision

1. Keep one deployed FieldView Worker per environment. Daily readiness is a Workflow class within that Worker, not a separate Worker deployment.
2. Resolve the TBA current season and acquire/publish its event and team directories through DiscoveryStore.
3. Iterate the current-season event keys sequentially. For each event, address its deterministic EventRuntime ID, inspect its canonical EventState publication and source freshness, and queue a complete event-resource refresh only when the publication is missing/invalid or one or more sources are stale.
4. Iterate the current-season team keys sequentially and apply the same readiness check to TeamRuntime and its TeamState resources.
5. For every entity requiring refresh, choose a randomized due time within the next five minutes. Persist that deadline in the entity runtime's local durable queue/alarm. The Workflow does not fetch entity resources and does not wait for the queued refresh to finish.
6. EventRuntime and TeamRuntime alarms process their own provider queues sequentially, with at most one provider request in flight per object. Different Durable Objects remain independently executable; there is no global provider mutex or queue.
7. Readiness refreshes are one-shot. They must not overwrite or move existing recurring polling schedules.
8. Frontend-facing event/team state reads return HTTP 404 until a valid canonical publication exists. Public reads do not create identities, queue provider work, or synthesize placeholder state. Once a valid publication exists, reads return that persisted publication, including stale last-good data. Failed refreshes never erase it.
9. Schedule the daily readiness Workflow at 10:00 UTC so the sweep begins before typical US morning usage.

## Consequences

- The daily Workflow is intentionally sequential and may take longer to finish. It is not optimized for minimum completion time.
- The five-minute random window distributes refresh starts; it is not a strict global concurrency cap. Independent Durable Objects may still overlap, but each object's own provider queue is serialized.
- A newly discovered entity may remain unavailable (404) until its first durable canonical publication is generated.
- Stale but previously published state remains readable while refresh runs; missing state is not represented as an empty or partial placeholder.
- Entity runtimes remain responsible for their own acquisition, reconciliation, retry behavior, persistence, and publication. The Workflow only discovers, inspects, and schedules.
- This decision does not introduce a global TaskScheduler Durable Object, global provider lease, or additional Worker deployment.
