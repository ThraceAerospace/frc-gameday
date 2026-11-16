# @fieldview/domain

Canonical, provider-independent FieldView domain models and rules.

## Ownership boundaries

This package must remain independent of:

- provider packages and generated provider schemas;
- Next.js, React, and other presentation code;
- Cloudflare Workers and Durable Objects;
- storage, transport, and other infrastructure implementations.

Provider adapters may depend on this package to produce normalized FieldView values. The domain package must never import provider implementations.

## Canonical identity

Team, event, and match identity use the established TBA keys as opaque strings:

- Team: `frc3461`
- Event: `2026cthar`
- Match: `2026cthar_qm1`

Team-season identity is the combination of a canonical team key and season year. Domain consumers must not parse TBA key formats to reconstruct identity. Provider adapters validate external keys and translate them at the boundary.

Aggregate records begin with TBA data. Other providers enrich them; authority is determined per field, not globally. A missing or failed enrichment must not invalidate the TBA-backed record.

## Current models

- `FieldViewTeam` and `FieldViewTeamSeason`
- `FieldViewEvent` (requires an IANA timezone)
- `FieldViewMatch` and normalized match-level/alliance types

These are intentionally foundational. Event-team status, provider enrichment, provenance/freshness, reconciliation patches, and serializable client contracts will be modeled separately.

Optional properties represent data that may not be present in a snapshot. Where a property is present with `null`, it represents an explicit known absence. Provider acquisition failures and merge instructions do not belong in these domain records; those semantics will be defined in dedicated reconciliation types.

Canonical models are added in small reviewed slices. Do not move legacy provider-shaped types here wholesale.
