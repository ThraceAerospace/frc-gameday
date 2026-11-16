# ADR 0002: EventRuntime ownership and event-team reconciliation

- **Status:** Proposed — implementation blocked pending resolution
- **Date:** 2026-11-16

## Context

The legacy application combines event acquisition, provider-shaped data, reconciliation, and client delivery in `src/lib/events/EventState.ts` and a browser SharedWorker. The target needs one authoritative server-side owner for event state, while keeping domain objects independent from runtime machinery.

The migration inventory identifies TBA event metadata, event teams/status, matches, playoff alliances, rankings, OPR/DPR/CCWM, webcasts, and derived analytics as related event-scoped resources. Not all of these necessarily share the same freshness or lifecycle.

## Proposed direction

- Start with **one EventRuntime Durable Object per event** as the initial candidate.
- Keep its implementation internally modular; internal classes/modules are not separate Durable Objects or independent concurrency boundaries.
- The EventRuntime is the likely authoritative owner of event-scoped state and reconciliation.
- Do not create one Durable Object per domain interface.
- Do not add a TeamRuntime or AnalyticsRuntime unless an independent lifecycle, coordination, or scaling requirement is demonstrated.
- A team-season profile may be shared across events, but event participation/status remains event-scoped unless a later decision establishes a different authoritative owner.

## Unresolved questions

1. Which resources are authoritative EventRuntime state, and which are recomputable projections?
2. Does EventRuntime own all FieldViewEventTeam fields, or only event participation/status while team-season metrics are published by a separate service?
3. Which data is persisted in Durable Object SQLite, which is held in memory, and which is reacquired from providers?
4. What is the retention policy for completed events and derived analytics?
5. How do scheduled refreshes and webhook-triggered invalidation coordinate without duplicate provider requests?
6. How are partial provider failures and explicit field clears represented in stored state?

## Event-team status refresh — options to verify

TBA's full-event team-status response is a coherent dataset and includes qualification ranking/record, matches played, DQ, alliance selection, playoff progression, last/next match references, and pit location. It is a stronger event-level reconciliation source than attempting to infer all status changes from individual match notifications.

Before choosing a refresh policy, verify:
- whether a supported per-team status endpoint exists and its request cost;
- whether webhook match payloads can safely identify dirty teams without assuming only match participants can change status;
- whether dirty-team refresh can be coalesced/debounced and when a full-event refresh is cheaper;
- what active-event safety-net interval is appropriate (a 5–10 minute interval is a candidate, not an accepted value);
- how a generation/version counter prevents an older fetch from clearing a newer dirty marker.

Keep match freshness and team-status freshness separate. A successful authoritative null/clear updates that field; a failed request must not erase prior valid state. Derive UI summaries from normalized structured fields, not provider HTML summary strings. Last/next match values should reference FieldViewMatch keys rather than duplicate match records.

## Acceptance criteria before implementation

- One explicit writer/owner is named for every event resource.
- Refresh triggers, request coalescing, stale-response protection, and full reconciliation are specified.
- Field-level merge semantics distinguish omitted, null, explicit clear, zero, and failed acquisition.
- Provider request volume and failure behavior are bounded and testable.
