# ADR-0016: Canonical data ownership and temporary analytics composition

- **Status:** Accepted, clarified by ADR-0020
- **Date:** 2026-11-23
- **Scope:** EventRuntime, TeamRuntime, cross-runtime analytics, persisted domain data

## Decision

Canonical data has exactly one owning runtime and one authoritative persisted representation. This is a storage and contract invariant.

- EventRuntime owns event identity, event/team participation, matches, playoff alliances, event-scoped provider endpoint records, and event-wide analytics.
- TeamRuntime owns team identity, team/year provider endpoint records, team season history, team-event participation state, and team-scoped analytics.
- EventState and TeamState are normalized read projections derived from their owner's provider endpoint records. Under ADR-0020 they are ephemeral and are not persisted canonical records.
- EventRuntime does not embed complete TeamEventState records or team profiles. TeamRuntime does not embed complete event records, match records, or event-owned participation objects.
- A match may retain its match-local alliance roster as team keys and relationship-scoped facts. It must not copy team profiles, team-owned EPA/OPR metrics, or complete playoff-alliance records.
- TeamRuntime season history references EventRuntime-owned events by event key; it does not embed complete event records.
- Cross-runtime dependencies use stable references identifying the owner, owner identity, record type/identity, and source revision where relevant. The owning runtime validates and resolves its own records through explicit interfaces.
- Because EventRuntime and TeamRuntime have separate Durable Object SQLite databases, cross-runtime references are logical foreign keys; no caller directly reads another runtime's storage.

## Temporary analytics composition

When an analytics operation requires inputs from multiple runtimes, the orchestrator reads versioned inputs through owner interfaces and combines them in memory for that operation. The working set is discarded when the calculation completes. Persist only the result owned by the calculating runtime and the minimal provenance needed to validate it.

A consumer-facing read projection is allowed only for a concrete read capability. It must be minimal, bounded, versioned, explicitly non-authoritative, and must not embed complete foreign canonical objects.

## Normalization and persistence rules

- Do not duplicate provider payloads, canonical entities, match records, or complete nested aggregates across runtime boundaries.
- Do not persist a temporary working set merely to simplify a later read.
- Avoid unbounded nested collections in cross-runtime publications.
- A publication must not become a second database assembled from other runtimes.
- If a contract crosses ownership boundaries, represent foreign data through stable references and resolve it through the owner.
- Splitting or chunking an unnecessarily duplicated aggregate is not a substitute for correcting ownership and data shape.

## Consequences

EventRuntime analytics performs cross-runtime reads during background operations, not ordinary public snapshot reads. It persists event-owned analytics and provenance, not team-state inputs. TeamRuntime remains the sole writer for each team's event state and team analytics. Event and team read projections remain ephemeral under ADR-0020.
