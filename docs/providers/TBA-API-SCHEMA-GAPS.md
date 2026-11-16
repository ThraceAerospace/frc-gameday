# TBA API schema gaps

This document tracks fields observed in live The Blue Alliance (TBA) API responses that are not represented by the generated OpenAPI types used by FieldView.

The generated files should remain generated and unchanged for these local compatibility fixes. Extend the provider-facing types in `packages/providers/tba/src/types.ts` until TBA updates its schema.

## 2026 match score breakdown: `hubScore.uncounted`

- **Endpoint:** `GET /api/v3/match/{match_key}/`
- **Example match:** `2026arc_sf13m1`
- **Response paths:**
  - `score_breakdown.red.hubScore.uncounted` — observed value: `4`
  - `score_breakdown.blue.hubScore.uncounted` — observed value: `0`
- **Schema omission:** `components.schemas.HubScore_2026` does not declare `uncounted`.
- **Expected upstream correction:** Add `uncounted` to the 2026 hub score schema with its correct type and description.
- **FieldView workaround:** The provider-facing `TBAMatch` type extends the nested 2026 hub score shape to accept this field. The original response value is preserved; no transformation or reinterpretation is performed.
- **Upstream report:** Not yet filed. The connected GitHub integration returned HTTP 403 when attempting to create an issue in `the-blue-alliance/the-blue-alliance`.

## Related known omission: playoff status

The live Team Event Status response has included year/bracket-specific playoff fields that are not represented by TBA's generated schema, including `playoff_type` and `double_elim_round`. This was the earlier schema-gap workaround in the TBA provider types.

## Maintenance

When TBA updates its OpenAPI schema, regenerate the provider types and remove any local extension that is no longer needed. Do not edit generated files manually.
