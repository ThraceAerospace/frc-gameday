# @fieldview/domain

FieldView's canonical product data models, normalization, correlation, and domain rules.

## Data integrity rule

Provider payloads enter FieldView without implicit changes:

- TBA payloads pass directly into FieldView normalization.
- Statbotics payloads pass directly into FieldView normalization.
- Data from every other provider passes through unchanged.

No provider value may be silently renamed, converted, reinterpreted, defaulted, omitted, or overwritten. Any approved transformation must be represented by a specifically named field in the forward-facing FieldView model and documented with its source fields and transformation. A transformation must not be implemented until it has been explicitly described and approved.

FieldView models are first-class product objects, not direct aliases of provider responses. Where a field passes through provider data, it uses the exact provider field type and preserves its original name, value, nullability, and structure. FieldView-owned associations and calculations are separately named and documented. See [FieldView Data Model v1](../../docs/domain/FIELDVIEW-DATA-MODEL-V1.md).

## Ownership boundaries

This package must remain independent of:

- Next.js, React, and other presentation code;
- Cloudflare Workers and Durable Objects;
- storage, transport, and other infrastructure implementations.

The domain package may depend on provider packages for types used by unchanged provider-sourced fields. It must not import provider clients or transport implementations. Provider-specific types remain backend-only and must not leak into client contracts. Keep client DTOs explicit and serializable.

## Identity

TBA team, event, and match keys remain unchanged source identifiers. The TeamKey, EventKey, and MatchKey aliases do not brand, validate, parse, or transform those values.

Team-season identity is represented separately by FieldViewTeamSeason, which pairs an unchanged TBA team key with a FieldView season year.

## Model baseline

The initial canonical object set is FieldViewTeam, FieldViewTeamSeason, FieldViewEvent, FieldViewEventTeam, FieldViewMatch, FieldViewPlayoffAlliance, FieldViewEventAnalytics, and FieldViewTeamAnalytics. FieldViewMatch is the first detailed model and combines TBA match information with independent predictions, team statistics, playoff alliance associations, explicit analysis, flags, and provenance.

The v1 domain-model specification documents responsibilities, source overlaps, deliberate omissions, and the Archimedes SF13 reference fixture. Initial domain types are now implemented for the canonical object set, with `FieldViewMatch` retaining exact TBA match fields and explicitly typed Statbotics associations. Typecheck, fixture validation, and the separate versioned client contract remain follow-up work.

Client contracts must be explicit, serializable, and provider-independent. Provider types must not leak into those contracts.
