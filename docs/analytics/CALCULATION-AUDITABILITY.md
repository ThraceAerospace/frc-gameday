# FieldView analytics: calculation ownership and auditability

**Status:** Architecture requirement for the analytics migration  
**Applies to:** Match, alliance, team-at-event, and event analytics

## Objective

Move analytics calculation and interpretation out of the Next.js application and into the FieldView backend. The frontend consumes published canonical results; it does not fetch TBA or Statbotics data to calculate analytics.

The first migration preserves the existing formulas, thresholds, eligibility rules, comparison populations, and interpretation behavior. Existing calculations are a behavioral reference, not an assertion that the math has already been independently verified. Hand verification is a separate follow-up activity.

## Canonical ownership

- `FieldViewMatch` owns match-scoped analysis and flags that should appear anywhere that match is rendered.
- `FieldViewTeamState` represents the assembled totality of what FieldView knows about one team at one event. It owns event-scoped team analytics, comparisons, and review findings.
- `FieldViewEventState` represents the assembled totality of what FieldView knows about an event. It owns event-wide analytics and the event's collection-level analytics state.
- The event's existing EventRuntime remains the orchestration and publication owner. Do not create a Durable Object per match or a second analytics runtime.
- Provider acquisition remains behind backend adapters. The browser receives canonical published state only. Admin access remains protected by backend routes and server-side credentials.

## Calculation architecture

Calculations must be pure with respect to their inputs: no provider fetches, Redis access, request handling, UI formatting, or hidden global state inside a calculation operation.

Use a small allowlisted operation registry. A versioned definition selects an operation by stable `operation_key`; definitions must not contain arbitrary executable JavaScript and must never be evaluated as code. This keeps formulas reviewable while keeping execution constrained and testable.

Each definition must document:

1. Stable definition key and semantic version.
2. Scope: match, alliance, team, or event.
3. Required and optional inputs, with canonical source paths and units.
4. The observation population, inclusion rules, and exclusion rules.
5. A human-readable formula and ordered calculation steps.
6. Output unit and interpretation/threshold rules.
7. Known limitations and caveats.

Changing a formula, source mapping, eligibility rule, comparison population, or interpretation in a way that changes meaning requires a definition-version change. Cosmetic presentation changes do not.

## Audit record

Every calculation run should publish a run-level audit record containing:

- unique calculation ID, engine version, and calculation timestamp;
- each definition key and version used;
- normalized input manifest: provider, resource, source revision, fetch time, record count, included count, excluded count, and availability status;
- deterministic digest of the normalized input manifest;
- warnings, missing inputs, and partial-data caveats.

Metric-level results continue to expose their own sample size, population, comparison population, baseline, status, and limitations. The audit manifest must make it possible to trace a published value back to the exact source revisions and population used. Where public reproducibility requires the actual normalized records, retain or expose a controlled, versioned input snapshot rather than relying on a digest alone.

## Recalculation and publication

- A changed TBA match representation invalidates only calculations that depend on that match plus affected event/team aggregates.
- A changed Statbotics representation invalidates calculations that consume that Statbotics resource.
- Recalculate through coalesced EventRuntime work; do not poll Statbotics on a recurring schedule.
- Publish partial results when only some inputs are ready. Preserve the last good value for a failed refresh and mark the affected result stale/partial through its audit/provenance.
- Match analysis/flags must be embedded in `FieldViewMatch`; team-at-event analytics in `FieldViewTeamState`; event-wide analytics in `FieldViewEventState`.
- The existing analytics Multiplexer topic is the publication seam. Connect it to the authoritative EventRuntime publisher; keep the one shared Multiplexer.

## Migration and verification policy

1. Capture representative outputs from the existing Next.js analytics implementation as parity fixtures.
2. Move calculation operations without changing their behavior. Do not opportunistically correct suspicious formulas during the ownership migration.
3. Add the definition catalog and input audit manifest alongside the migrated operations.
4. Compare old and new outputs over representative historical and live events.
5. Hand-check the formulas and input construction independently. Record any discovered math correction as a deliberate, versioned change with before/after examples.
6. Remove the legacy Next.js calculation/acquisition path only after backend parity and frontend consumption are established.

A migration can temporarily break a view or expose an existing calculation defect; that is acceptable during this branch's development. It is not acceptable to silently change semantics or claim that the calculations are verified when they are not.

## Current migration implementation

- The original pure calculation implementation has been moved, without changing its calculation bodies, from `apps/web/src/lib/insights/calculations.ts` into `packages/analytics/src/calculations.ts`.
- The web calculation module is now a compatibility re-export. This removes the implementation from the app layer while the orchestration and provider acquisition paths are migrated.
- `packages/analytics/src/definitions.ts` contains reviewable versioned definitions for the existing score residual, EPA, team contribution, qualification, penalty, playoff, season comparison, and match-review calculations.
- `packages/analytics/src/audit.ts` creates a deterministic SHA-256 digest over a normalized input manifest and records the exact definition versions used.
- Match review flags are calculated in the analytics package and attached to the server-produced event analytics response. The dashboard renders supplied flag evidence instead of recomputing those thresholds in the browser.
- EventRuntime calculates canonical analytics in a persisted, coalesced alarm job triggered by changed provider endpoint revisions and match webhooks. Public snapshot reads do not execute analytics calculations; they overlay the most recently published analytics projection onto the latest canonical provider state.
- The job calculates and publishes `FieldViewMatch.analysis` (actual/predicted scores, residuals, alliance pre/post EPA totals and input coverage) and `FieldViewMatch.flags` (prediction classification, winner/upset, phase anomaly, large residual, high alliance EPA, and penalty flags).
- `FieldViewEventState.analytics` now contains event-wide mean residual, residual standard deviation, MAE, RMSE, winner-prediction accuracy, and review findings.
- `FieldViewTeamState.analytics` now contains the team's latest event EPA and components, event-relative EPA percentile, mean eligible alliance EPA contribution share, match appearances, and team-specific match review findings. OPR/DPR/CCWM remain available through the canonical event-team association.
- Match, event, and team results share an audit manifest with TBA match/team and Statbotics match source revisions, fetch times, record/inclusion/exclusion counts, availability status, calculation ID, engine version, definition versions, warnings, and a deterministic SHA-256 input-manifest digest.
- The match flag definitions preserve the existing implementation's threshold behavior, including upper-middle median/MAD selection for even-sized samples and nearest-rank quantiles. Those conventions remain subject to independent hand verification; they were not silently corrected during migration.
- `FieldViewEventState` is now the primary event-state normalizer and Worker return type. `FieldViewEventSnapshot` and its normalizer remain deprecated compatibility aliases. `FieldViewTeamState` is assembled per team/event and includes only that team's canonical match participation.

### Remaining ownership work

- Current dependency invalidation is intentionally coarse: a relevant provider revision schedules a whole-event calculation. Refine this to recalculate only affected match results and the event/team aggregates that depend on them, while retaining whole-event fallback for broad changes.
- Season-aware team comparisons and the full legacy dashboard payload (including detailed qualification/playoff investigations and season cohort) still use the Next.js progressive analytics job.
- The full dashboard has not yet switched to canonical published analytics, and the legacy Next.js orchestration/provider path has not been removed.
- The analytics publication currently increments the canonical event-state revision. A dedicated `analytics` Multiplexer notification and corresponding client subscription/recovery are still pending.
- Formula hand verification remains separate; no math corrections are included in this migration.
