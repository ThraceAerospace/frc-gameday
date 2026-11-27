# @fieldview/domain

FieldView's canonical product data models, normalization, correlation, and domain rules. The package is provider-independent at its public contract boundary and is the shared domain data model consumed by the backend and frontend.

## Data integrity

Provider payloads enter FieldView without implicit changes:

- TBA payloads pass into FieldView normalization unchanged.
- Statbotics payloads pass into FieldView normalization unchanged.
- Other provider payloads pass through unchanged.

No provider value may be silently renamed, converted, reinterpreted, defaulted, omitted, or overwritten. Any approved transformation must be represented by a specifically named field in the forward-facing FieldView model and documented with its source fields and transformation.

FieldView models are first-class product objects, not direct aliases of provider responses. Where a field passes through provider data, it preserves the provider field's name, value, nullability, and structure. FieldView-owned associations and calculations are separately named and documented. See [FieldView Data Model v1](../../docs/domain/FIELDVIEW-DATA-MODEL-V1.md).

## Ownership boundaries

This package must remain independent of Next.js, React, Cloudflare Workers, Durable Objects, storage, and transport implementations.

The domain may use provider packages for types needed to preserve unchanged provider-sourced fields. It must not import provider clients or transport implementations. Provider schemas and response envelopes are not frontend contracts. The frontend consumes the serialized FieldView domain models; do not create a parallel DTO package or duplicate the domain shape.

Provider acquisition, endpoint persistence, freshness, and provenance are owned by the backend runtime. The domain package owns pure model construction, normalization, correlation, and domain rules.

## Identity

TBA team, event, and match keys remain unchanged source identifiers. TeamKey, EventKey, and MatchKey aliases do not brand, validate, parse, or transform those values.

Team-season identity is represented separately by FieldViewTeamSeason, which pairs the unchanged TBA team key and official TBA team_number with a FieldView season year. TBA team_number directly correlates with Statbotics' numeric team value; no additional Statbotics ID field is needed.

## Model baseline

Canonical concepts include FieldViewTeam, FieldViewTeamSeason, FieldViewEvent, FieldViewEventTeam, FieldViewMatch, FieldViewPlayoffAlliance, FieldViewEventState, FieldViewTeamState, and scope-owned analytics results.

The v1 domain-model specification documents responsibilities, source overlaps, deliberate omissions, and the Archimedes SF13 reference fixture. Normalizers are pure association boundaries: they do not fetch providers, mutate source records, or invent defaults.

- `normalizeFieldViewMatch` composes independently acquired match resources while preserving the complete TBA match payload and keeping TBA and Statbotics predictions independent.
- `normalizeFieldViewEventTeam` composes one event-team relationship from its TBA team key, optional team-event status, and event-level OPR/DPR/CCWM.
- `normalizeFieldViewTeamSeason` correlates the TBA team number with the Statbotics team-year record and carries explicit source provenance.
- EventState and TeamState normalizers derive ephemeral client-facing projections from the endpoint records held by their owning runtimes.

The canonical FieldView domain objects are serialized directly for clients. Serialization preserves the domain model's values and absent-versus-null semantics; it is not a second mapping or normalization layer.
