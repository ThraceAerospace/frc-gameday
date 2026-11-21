# ADR-0016: Canonical data ownership and temporary analytics composition

- **Status:** Accepted
- **Date:** 2026-11-21
- **Decision owners:** FieldView architecture

## Context

EventRuntime and TeamRuntime are separate Durable Objects with independent SQLite storage, activation, scheduling, and publication lifecycles. Each runtime is the authoritative owner of its entity-scoped canonical data.

The previous event-view design persisted a complete array of TeamRuntime-owned `FieldViewTeamEventState` records inside EventRuntime's event-view publication. Those team states included full match objects, even though the canonical match records belong to EventRuntime. This repeated the same event match data across the event state and the states of participating teams, then repeated all team states again in EventRuntime's publication. Chunking that publication reduced the size of individual SQLite writes but preserved the underlying duplication and ownership violation.

Analytics is a legitimate consumer of a combined event/team dataset. That requirement does not imply that the combined input should become a durable model or publication.

## Decision

### 1. One canonical owner

Each canonical record has one authoritative owner and one authoritative persisted representation.

- EventRuntime owns event-scoped provider resources, `FieldViewEventState`, canonical event matches, and `FieldViewEventAnalytics`.
- TeamRuntime owns team-scoped provider resources, `FieldViewTeamState`, `FieldViewTeamEventState`, and team-scoped analytics.
- A runtime does not persist complete canonical records owned by another runtime.

### 2. Logical foreign references

Cross-runtime dependencies use references that identify:

- owner runtime type;
- owner identity (for example, event key or team key);
- record type and record identity;
- source revision when revision consistency matters.

The references are logical foreign keys. Since each Durable Object has its own SQLite database, references are resolved by requesting the owning runtime; callers never access another runtime's storage directly.

### 3. Temporary analytics composition

An EventRuntime analytics operation follows this lifecycle:

1. Read the canonical `FieldViewEventState` and its source revision from EventRuntime-owned storage.
2. Identify the participating teams from the event roster.
3. Request each participant's `FieldViewTeamEventState` from that participant's TeamRuntime. TeamRuntime remains responsible for creating, reconciling, and persisting its own state.
4. Collect the returned team-state revisions and validate that the event and team inputs correspond to one coherent source set. If inputs changed during the operation, discard the calculation and schedule a retry.
5. Combine the event state and available participant team states in memory only for the event analytics calculation.
6. Persist only `FieldViewEventAnalytics`, its analytics revision, source-revision provenance, and explicit coverage/completeness metadata in EventRuntime.
7. Release the temporary combined input when the operation completes.

A failed calculation or inconsistent source set must not replace the last-good analytics publication. Concurrent requests coalesce behind one durable analytics operation; public reads remain read-first and never wait for the operation.

### 4. Bounded consumer projections

A consumer-facing `FieldViewEventView` may combine event-owned state and event analytics at read time when the endpoint requires both. It may include logical references to participant TeamRuntime records and explicit coverage metadata. It must not embed complete `FieldViewTeamEventState` objects or their match collections.

If a consumer needs a team's detailed event state, it requests that state from the corresponding TeamRuntime. EventRuntime's ordinary read endpoints do not fan out to all TeamRuntimes.

### 5. No persisted working sets

A temporary calculation input is not a canonical model, cache, snapshot, or publication. Do not persist it merely to simplify a later read. Persisting a derived projection is permitted only for a concrete, independently justified read requirement; the projection must be minimal, bounded, non-authoritative, versioned, and must not duplicate complete foreign records.

Chunking or splitting a duplicated aggregate is not an acceptable substitute for correcting its ownership and data shape.

## Consequences

- EventRuntime analytics performs cross-runtime reads during its background operation, not during ordinary public reads.
- EventRuntime persists the analytics result and provenance, not the team-state inputs.
- TeamRuntime remains the sole writer for each team's event state.
- The event view is a small composition of event-owned state, event analytics, participant references, and coverage.
- Event and team match data are not copied into multiple canonical state records.
- Tests must verify owner boundaries, source-revision consistency, last-good publication preservation, and the absence of foreign canonical records in persisted EventRuntime publications.
