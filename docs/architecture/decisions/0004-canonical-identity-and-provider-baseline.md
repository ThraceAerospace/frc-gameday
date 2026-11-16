# ADR 0004: Provider identifiers and FieldView data preservation

**Status:** Accepted  
**Date:** 2026-11-16

## Context

FieldView consumes multiple FRC data providers. Their identifiers and data coverage are not always consistent. TBA is the initial source for team, event, and match records, while Statbotics supplies additional performance data.

FieldView must preserve the meaning of provider data so that provider documentation remains directly applicable to the values received and exposed by FieldView.

## Decision

1. TBA team, event, and match keys are used as source identifiers without changing their values: team frc3461, event 2026cthar, and match 2026cthar_qm1.
2. These keys are treated as opaque strings. FieldView does not parse, reformat, brand at runtime, or otherwise transform them.
3. Team-season identity is represented separately as the unchanged TBA team key paired with a FieldView season year.
4. TBA payloads pass directly into FieldView normalization unchanged.
5. Statbotics payloads pass directly into FieldView normalization unchanged.
6. Data from any other provider passes through unchanged.
7. No provider value may be silently renamed, converted, reinterpreted, defaulted, omitted, or overwritten.
8. Any transformation must be explicitly described and approved before implementation. Its result must be represented by a specifically named field in each forward-facing data model, with documentation of its source fields and transformation.
9. Provider payloads and provider-specific types remain backend-only. Client contracts must be explicit, serializable, and provider-independent.
10. Event timezone retains the source provider value and nullability. The presentation rule to display event dates and times in the event timezone does not authorize changing the stored provider value or inventing a fallback.

## Consequences

- Provider packages own their generated schemas, API clients, services, provider-specific types, and generation tooling. They pass provider payloads into FieldView normalization unchanged.
- FieldView domain normalization owns correlation, associations, and explicitly approved transformations.
- Other provider payloads also pass through unchanged unless a separately described and approved decision changes this rule.
- Domain models may use provider types for unchanged pass-through fields. Provider types must not leak into client contracts.
- Derived, combined, or calculated values require separate named fields and documented source semantics.
- Merge, provenance, freshness, and explicit-clear semantics remain separate concerns and must be specified before provider reconciliation is implemented.

## Initial domain types

The initial provider-shaped domain types are direct aliases of the corresponding TBA payload types. FieldView-specific models such as FieldViewTeamSeason remain separate and must not imply a transformation of provider data.
