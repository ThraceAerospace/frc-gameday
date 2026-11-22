# ADR-0009: District data ownership and acquisition

- **Status:** Superseded by the simpler membership-reference decision recorded in ADR-0016
- **Date:** 2026-11-21
- **Decision owners:** FieldView project

## Superseded decision

The previous decision assigned canonical district directories, district snapshots, provider acquisition, and district resource retention to TaskScheduler. That introduced a district-owned data lifecycle even though FieldView has no current product requirement to browse or query districts independently.

## Current decision

FieldView does not maintain district-owned canonical records.

- TeamRuntime retains the district membership data returned as part of that team's own provider data.
- EventRuntime retains the district membership data returned as part of that event's own provider data.
- District membership is displayed or consumed only as a property/reference of its owning team or event.
- There is no district directory, district snapshot, district-specific provider acquisition, district cache, district runtime, district scheduler job, or district analytics.
- No team/event page or API should fetch a separate district record to resolve membership.

If a concrete district feature is requested later, define its required data and ownership then. Do not pre-build a district aggregate or query surface.

## Retirement

The migration removes the district domain aggregate and normalizer, district-specific Worker routes and acquisition, district-specific Next.js pages and APIs, and district navigation. On TaskScheduler activation, legacy `district-directory:` and `district-resource:` records are deleted. Team and event provider records continue to retain their own district membership fields.

This ADR remains as the historical record of the superseded choice; ADR-0016 and AGENTS.md define the active rule.
