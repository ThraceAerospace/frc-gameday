# ADR 0004: Canonical identity and TBA-first aggregates

**Status:** Accepted
**Date:** 2026-11-16

## Context

FieldView consumes multiple FRC data providers. Their identifiers and coverage are not always consistent. The Blue Alliance (TBA) has the longest-established and most widely reused FRC API identifiers, and its key conventions are commonly reproduced by other systems.

Introducing a second opaque FieldView identity system would add mapping and reconciliation work without a demonstrated benefit.

## Decision

1. TBA keys are the canonical FieldView identifiers for teams, events, and matches:
   - Team: `frc3461`
   - Event: `2026cthar`
   - Match: `2026cthar_qm1`
2. These keys are treated as opaque strings outside provider adapters. FieldView does not derive identity by parsing their format.
3. Team-season identity is the composite of canonical team key and season year.
4. Aggregate records are initialized from the corresponding TBA data. Other providers enrich those records with additional fields and metrics.
5. Provider identifiers may be retained as source references where useful, but they do not replace canonical FieldView identity.
6. Authority is field-specific. TBA is the identity and initial-record baseline; another provider may be authoritative for a particular enrichment, such as its own performance metrics.
7. Missing or failed enrichment does not invalidate or erase the TBA-backed aggregate.
8. A FieldView event requires an IANA timezone. Event dates remain calendar dates; match timestamps represent instants and are displayed in the owning event's timezone.

## Consequences

- No separate opaque FieldView ID registry or general identity-mapping layer is introduced.
- Provider packages own their generated schemas, API clients, services, normalization, and generation tooling. Domain models may use those provider types directly where data is passed through; FieldView-defined types remain appropriate for normalized, combined, or calculated semantics.
- Domain models may import provider packages and use generated provider types for pass-through fields. Provider types are backend-only and must not leak into client contracts.
- Merge, provenance, freshness, and explicit-clear semantics remain separate concerns and must be specified before provider reconciliation is implemented.
- If a future provider cannot map reliably to a TBA key, that integration must handle the unmatched record explicitly rather than silently inventing a competing canonical identity.

## Initial domain types

The initial domain foundation defines `TeamKey`, `EventKey`, and `MatchKey` as opaque branded string types, plus `FieldViewTeam`, `FieldViewTeamSeason`, `FieldViewEvent`, and `FieldViewMatch`.
