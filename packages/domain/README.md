# @fieldview/domain

FieldView's derived-data domain models and rules. The domain may use upstream provider types directly when representing provider-shaped data.

## Ownership boundaries

This package must remain independent of:

- Next.js, React, and other presentation code;
- Cloudflare Workers and Durable Objects;
- storage, transport, and other infrastructure implementations.

The domain package may depend on provider packages and their generated schemas. Provider-specific types remain backend-only and must not leak into client contracts. Keep client DTOs explicit and serializable.

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
