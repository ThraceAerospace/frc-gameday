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

The domain package may depend on provider packages for types used by unchanged provider-sourced fields. It must not import provider clients or transport implementations. The FieldView domain model is the shared application data model for backend and client. The client receives serialized FieldView domain objects; do not create a parallel DTO package or duplicate the domain shape. Provider clients and acquisition implementations remain outside the client.

## Identity

TBA team, event, and match keys remain unchanged source identifiers. The TeamKey, EventKey, and MatchKey aliases do not brand, validate, parse, or transform those values.

Team-season identity is represented separately by FieldViewTeamSeason, which pairs an unchanged TBA team key with a FieldView season year.

## Model baseline

The initial canonical object set is FieldViewTeam, FieldViewTeamSeason, FieldViewEvent, FieldViewEventTeam, FieldViewMatch, FieldViewPlayoffAlliance, FieldViewEventAnalytics, and FieldViewTeamAnalytics. FieldViewMatch is the first detailed model and combines TBA match information with independent predictions, team statistics, playoff alliance associations, explicit analysis, flags, and provenance.

The v1 domain-model specification documents responsibilities, source overlaps, deliberate omissions, and the Archimedes SF13 reference fixture. Initial domain types are implemented for the canonical object set. `normalizeFieldViewMatch` composes independently acquired TBA match, TBA prediction, TBA event OPR, and Statbotics match resources into a `FieldViewMatch`. It preserves the complete TBA match payload, keeps the two prediction sources independent, associates event OPR/DPR/CCWM from their own resource, and requires explicit TBA-to-Statbotics team identity associations. It does not calculate analytics or infer numeric Statbotics IDs from TBA keys. The Archimedes fixture tests exercise source preservation, resource association, and missing identity behavior.

The canonical FieldView domain objects are sent to clients through ordinary serialization. Serialization must preserve the domain model's values and absent-versus-null semantics; it is not a second mapping or normalization layer.

## Match normalization

`normalizeFieldViewMatch` accepts independently acquired source resources and
returns a canonical `FieldViewMatch`. It is a pure composition/association
boundary: it does not fetch providers, mutate inputs, calculate derived
analytics, or choose a winning source when providers overlap.

The caller supplies cross-provider team identity associations explicitly.
Statbotics EPA maps use string object keys, so the numeric Statbotics ID is
stringified only for map lookup; the numeric ID itself remains numeric in the
FieldView association. If no explicit association is supplied, the TBA team
remains present and its Statbotics ID/EPA fields remain absent.

See `test/match-normalization.test.mjs` and the Archimedes SF13 source fixture
for executable examples. This is an initial domain normalization seam, not yet
a provider ingestion/cache implementation. The resulting FieldView domain
object is the application data model; transport code serializes it directly.
