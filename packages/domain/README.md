# @fieldview/domain

FieldView's derived-data domain models and normalization rules.

## Data integrity rule

Provider payloads enter FieldView without implicit changes:

- TBA payloads pass directly into FieldView normalization.
- Statbotics payloads pass directly into FieldView normalization.
- Data from every other provider passes through unchanged.

No provider value may be silently renamed, converted, reinterpreted, defaulted, omitted, or overwritten. Any approved transformation must be represented by a specifically named field in the forward-facing FieldView model and documented with its source fields and transformation. A transformation must not be implemented until it has been explicitly described and approved.

The initial provider-shaped models are direct type aliases. They preserve upstream field names, value representations, types, nullability, and structure.

## Ownership boundaries

This package must remain independent of:

- Next.js, React, and other presentation code;
- Cloudflare Workers and Durable Objects;
- storage, transport, and other infrastructure implementations.

The domain package may depend on provider packages and their generated schemas. Provider-specific types remain backend-only and must not leak into client contracts. Keep client DTOs explicit and serializable.

## Identity

TBA team, event, and match keys remain unchanged source identifiers. The TeamKey, EventKey, and MatchKey aliases do not brand, validate, parse, or transform those values.

Team-season identity is represented separately by FieldViewTeamSeason, which pairs an unchanged TBA team key with a FieldView season year.

## Current models

- FieldViewTeam is a direct alias of TBATeam.
- FieldViewEvent is a direct alias of TBAEvent; its nullable timezone remains nullable.
- FieldViewMatch is a direct alias of TBAMatch; TBA competition levels, timestamps, and alliance structure remain unchanged.
- FieldViewTeamSeason is a FieldView-defined season-scoped reference.

Future combined, calculated, or transformed data belongs in separately named and documented fields or models. No transformation is implied merely because a value is represented in the domain package.

Client contracts must be explicit, serializable, and provider-independent. Provider types must not leak into those contracts.
