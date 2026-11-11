# FieldView Test Strategy

## Purpose

This branch exists to establish automated confidence in FieldView's data contracts and data pipeline. The target is not a coverage percentage by itself. Tests must make it difficult for provider data, normalized data, cached state, derived analytics, or application consumers to silently change meaning.

This document is the working test inventory. Update it as the repository is inspected and tests are implemented. Keep changes on `testing/unit-test-suite` limited to test infrastructure, test code/fixtures, and the smallest production changes strictly required to make a data contract testable or correct a defect exposed by a test.

## Repository baseline (2026-11-11)

- The repository has no existing test files or test directory.
- `package.json` has no test script and no test framework dependency.
- TypeScript strict mode is enabled.
- TBA generated types are in `src/lib/tba/generated.ts`; application aliases are in `src/lib/tba/types.ts`.
- Statbotics generated types are in `src/lib/statbotics/generated.ts`; application aliases are in `src/lib/statbotics/types.ts`.
- Analytics/domain types are in `src/lib/insights/types.ts`.
- No top-level `src/types/` directory exists.
- The main data integration boundaries currently include:
  - TBA: `src/lib/tba/client.ts`, `src/lib/tba/service.ts`, `src/lib/tba/types.ts`.
  - Statbotics: `src/lib/statbotics/client.ts`, `src/lib/statbotics/service.ts`, `src/lib/statbotics/types.ts`.
  - Redis: `src/lib/cache/redis.ts`.
  - Event analytics: `src/lib/insights/progressive-service.ts`, `src/lib/insights/calculations.ts`, `src/lib/insights/season-cohort.ts`, `src/lib/insights/types.ts`.
  - HTTP consumers: `src/app/api/insights/**/route.ts` and the other route handlers under `src/app/api/`.
- Existing architecture documentation is useful context, but tests must assert the implementation's actual contracts and explicitly identify places where implementation and documented intent disagree.

## Authority and ownership contract

The following ownership model is the basis for data-authority tests:

| Data | Authority | FieldView responsibility |
| --- | --- | --- |
| Official events, event identity, event dates/timezone, team roster, match schedule, match scores/results, official rankings, alliances, OPR/DPR/CCWM | The Blue Alliance (TBA) | Acquire, cache, reconcile, and expose without inventing or silently changing official values |
| EPA, model predictions, model-derived team/event metrics, Statbotics historical records | Statbotics | Acquire and preserve provider values and provenance; do not present model estimates as official results |
| Normalized application contracts, joined/aggregated records, analytics findings, derived comparisons | FieldView | Own the schema, transformation rules, calculations, missing-data semantics, and schema versioning |
| Cached copies and resumable job state | Redis is storage/cache, not a new authority | Preserve source identity, freshness, schema version, and completeness; never let cache serialization redefine data meaning |
| Displayed values | Application consumers | Format and present the supplied contract; do not become a second acquisition, normalization, or analytics authority |

When sources disagree, use the field's declared owner. In particular, TBA owns the official schedule and actual match result; Statbotics predictions and EPA are model estimates and must not overwrite those official fields. A derived FieldView value must have an identifiable input set and calculation owner.

## Test inventory

### A. Provider contract tests — TBA

Primary files: `src/lib/tba/client.ts`, `src/lib/tba/service.ts`, `src/lib/tba/types.ts`.

Test:

- Request URL, authentication header, and endpoint construction.
- TBA `Cache-Control: max-age` parsing, including missing, malformed, quoted, zero, and valid values. Do not hardcode an upstream TTL.
- Redis cache hit, miss, expiry, force-refresh, malformed serialized entry, and ETag/304 behavior.
- A 304 without a usable cached entry or without a valid max-age fails explicitly.
- Upstream HTTP errors and JSON parsing failures do not become successful empty data.
- Cache tags are derived consistently for event, team, team-event, and match resources; invalidation removes only the intended cached resources.
- Match reconciliation preserves known completed results when an incoming provider representation is stale/incomplete, while accepting legitimate updates.
- Standalone match and collection reconciliation behavior are tested separately; do not assume their behavior is identical.
- Webhook cache mutations preserve unrelated records and do not fabricate fields when optional webhook fields are absent.
- Service helpers (for example, next/last match selection and event filtering) use deterministic fixtures and an injected clock where time affects behavior.

### B. Provider contract tests — Statbotics

Primary files: `src/lib/statbotics/client.ts`, `src/lib/statbotics/service.ts`, `src/lib/statbotics/types.ts`.

Test:

- Official API default (`https://api.statbotics.io`) when no override is configured; explicit `STATBOTICS_API_BASE_URL` override and endpoint construction; URL encoding for match/event keys.
- Cache key and lock key isolation by endpoint/query.
- Cache parsing rejects malformed structures rather than trusting a generic TypeScript cast.
- Upstream max-age and endpoint fallback TTL behavior, including the ten-minute request floor.
- ETag/304 behavior, stale-value fallback, refresh behavior, lock acquisition/release, and concurrent request behavior.
- Collection pagination uses stable filters, a 1,000-record page size, correct offsets, and terminates on empty/short pages.
- A failed page must not be represented as a complete collection.
- Null single-record responses remain distinct from failed collection requests.
- Provider-specific types remain inside the Statbotics adapter boundary; consumers use the service contract.

**Provider authority decision (2026-11-11):** The official Statbotics API at `https://api.statbotics.io` is the intended and default provider. `STATBOTICS_API_BASE_URL` is an explicit temporary override; it may point to Chondl's maintained fork at `https://api-statbotics.popcornpenguins.com` while the official API is unavailable. The fork is not the canonical authority today. If the official API does not return and Chondl's fork remains maintained and available, the fork may be adopted as the long-term alternative after an explicit decision. Tests must prove the official default and the temporary override independently; they must not silently bless the fork as permanent authority.

### C. Normalization and schema contract tests

Primary files: provider `types.ts`, `src/lib/insights/types.ts`, and the functions that construct analytics payloads.

Test:

- Raw provider types are mapped at the integration boundary, not recast ad hoc in pages/components.
- Required fields, nullable fields, optional fields, and discriminated status values have explicit semantics.
- Numeric provider values stay numeric; no unexplained string/number coercion.
- Missing provider observations remain `null`/unavailable/partial as specified, never silently become zero.
- TBA and Statbotics records are joined by stable event/team/match identifiers, not array position or display labels.
- The normalized response's schema version, event identity, generation time, provenance, and per-source status/freshness agree with the represented data.
- Serialization and deserialization preserve the same normalized shape and value semantics.

**Known metadata gap:** the current EventAnalytics envelope can report grouped TBA status as `ready` when optional rankings or playoff-alliance acquisition failed and the values are `null`. The current integration test covers successful optional absence only; it does not bless failed optional acquisition as ready. Add per-resource/partial source status coverage when the envelope is corrected.
- Provider-shaped fields that remain in the current EventAnalytics compatibility response are treated as a documented compatibility bridge, not mistaken for the final provider-independent DTO.

### D. Aggregation and calculation tests

Primary files: `src/lib/insights/calculations.ts`, `src/lib/insights/event-analytics.ts`, and other calculation modules under `src/lib/insights/`.

Test pure functions independently with small, explicit fixtures:

- Alliance scores, prediction residuals, win/loss/tie outcomes, and match labels.
- EPA totals and component metrics; incomplete or duplicate three-team rosters must not be presented as complete alliance totals.
- Percentiles, medians/MAD, calibration bins, Brier score, MAE, RMSE, and sample-size denominators.
- Qualification and elimination scopes remain separate.
- Team-season baselines select the most recent preceding official event; missing data at that event does not silently fall back to an older event.
- Event-wide comparisons include eligible teams with different prior-event baselines and expose coverage.
- Missing predictions are excluded from prediction denominators, not counted as zero.
- Every finding/flag is traceable to match evidence and has the documented sample requirements.
- Time-dependent sorting and event chronology use the event's timezone and stable fallback ordering.

Tests must use hand-calculated expected values for statistical functions. Do not merely snapshot a function's current output and call it correct.

### E. Pipeline and persistence integration tests

Primary files: TBA/Statbotics clients and services, `src/lib/cache/redis.ts`, `src/lib/insights/progressive-service.ts`, `src/lib/insights/season-cohort.ts`, and API route handlers.

Test the lifecycle at meaningful seams:

1. Provider response -> provider adapter.
2. Provider adapter -> normalized/FieldView contract.
3. Contract -> aggregation/calculation.
4. Result -> Redis serialization/persistence.
5. Redis -> service/API response.
6. API response -> application consumer contract.

Include:

- Cache warm/cold behavior and freshness metadata.
- Concurrent refreshes and finite lock behavior.
- Partial success across independent sources.
- Failure and retry behavior; failed acquisition must not be cached as a completed successful snapshot.
- Resumable jobs retain progress and do not duplicate or lose records.
- Schema-version mismatch triggers an explicit migration/rebuild/rejection path.
- Stale or incomplete responses cannot overwrite newer webhook/cache state.
- A failure in an optional resource does not erase successful independent resources.
- Cached and freshly assembled snapshots are equivalent where their source versions and inputs are equivalent.

Use mocked provider and Redis boundaries for deterministic tests. Reserve live-provider checks for an explicitly separate, opt-in contract/smoke workflow; ordinary tests must not require API keys, network access, or a live Redis instance.

### F. Data consistency and identity invariants

Test these across boundaries, not only inside individual functions:

- Team keys/numbers, event keys, match keys, and season/year remain stable.
- No records from another event/season leak into a scoped response.
- Duplicate provider records are handled deterministically.
- Missing, null, zero, and empty collection values remain semantically distinct.
- Source timestamps, fetch timestamps, and model generation timestamps are not conflated.
- Event dates/times use the event's IANA timezone; multi-event data uses each event's timezone.
- Cache keys and locks for different providers/resources cannot collide.
- Partial/failed source status remains visible through persistence and API delivery.

### G. Data authority and architecture enforcement

Add static checks (or lint rules where appropriate) to enforce:

- Components/pages do not call provider clients directly; acquisition stays in service/data layers.
- Components do not independently reimplement server-authoritative analytics calculations.
- Provider-owned values are not overwritten by another provider or by presentation formatting.
- Source-specific conversion/casting is isolated at explicit adapter boundaries.
- Shared application/domain types are declared centrally and imported by consumers rather than recreated locally.
- No new inline `type` aliases or `interface` declarations are added to arbitrary page/component files.
- Generated provider files are never hand-edited.
- Cross-layer imports do not bypass the intended source/service boundaries.

The repository currently has no top-level `src/types/` directory and has established provider-specific alias modules. Treat these as distinct concerns: generated raw provider schemas must remain with their generators, and provider adapter aliases should remain adjacent to their adapters unless a deliberate migration is approved. Shared FieldView-owned contracts should move toward a central `src/types/` structure. Do not perform a sweeping type relocation as incidental test setup; inventory existing declarations, define the target layout, and migrate in small test-backed steps. The immediate enforceable rule is that new shared types must not be invented inline in random components.

## Current implementation status

- [x] Add `npm test` using Node's built-in test runner; this avoids introducing a second test framework before the first contracts are mapped.
- [x] Add AST-based architecture checks that prevent application/component modules from importing low-level TBA/Statbotics clients and prevent raw generated provider schemas from bypassing their application type adapters.
- [x] Add deterministic unit coverage for the pure TBA match helpers: played/scored state, time selection, stable sorting without input mutation, next/last match selection, and team filtering.\n- [x] Add analytics calculation tests for population statistics, alliance result provenance, missing-value semantics, and three-team EPA completeness. These tests exposed partial/duplicate-roster EPA totals; the minimum production correction now requires three distinct teams before returning a complete alliance EPA total or contribution sample.\n- [x] Add EventAnalytics integration tests covering TBA acquisition, schedule ordering, Redis job persistence, versioned response/provenance, and reuse of a persisted job without re-fetching provider data.\n- [x] Inventory existing component-local type declarations and add an AST guard that prevents new declarations or additions to the legacy baseline; migrate existing declarations into central types in deliberate, test-backed steps.
- [x] Wire the suite into GitHub Actions for pushes to `main`/testing branches and pull requests targeting `main`. The workflow installed dependencies and passed all 38 tests on commit `e0d45e89c784581edcd43b38f423c9d0a27ccc80`. A local checkout was not available in this execution environment; CI is the verified execution source.
- [x] Add TBA client tests for cache miss/authentication/tagging, ETag/304 renewal, collection-vs-standalone match reconciliation, completed-match preservation, max-age enforcement, malformed cache recovery, webhook partial updates, and scoped tag invalidation.
- [x] Add Statbotics client tests for configured base URL/encoding, negative 404 caching, stale fallback/retry cooldown, and 1,000-record pagination.
- [x] Cover TBA malformed, quoted, zero, and missing max-age; verify in-flight upstream responses cannot overwrite a webhook-updated cache entry.
- [ ] Expand TBA tests for tag derivation across every resource family and cache mutation failure behavior.
- [x] Cover Statbotics malformed cache recovery, ETag/304 freshness, stale-cache lock contention, and rejection of a failed later pagination page.
- [ ] Expand Statbotics tests for concurrent callers, lock expiry/release under all failure modes, and endpoint-specific cache-key isolation.
- [ ] Expand normalized DTO validation beyond the current EventAnalytics v1 envelope; add source-specific partial/failure metadata and serialization round-trip coverage.\n- [ ] Expand integration coverage through the API route/consumer boundary, including lock contention, retries, refreshes, and corrupt persisted-job migrations.
- [ ] Add enforcement for the central FieldView type ownership policy after the existing inline declarations have been inventoried.

The TypeScript test loaders use the repository's existing TypeScript dependency. The standalone loader is limited to dependency-free modules with type-only imports; the mock loader injects deterministic Redis/provider boundaries for client and service tests. These are Node test-runner helpers, not production runtime code.

## Initial implementation order

1. Establish the test runner and common test conventions (no live network/Redis in default test runs).
2. Add deterministic unit tests for pure calculation and normalization functions.
3. Add TBA client tests for cache parsing, max-age/ETag behavior, and match reconciliation.
4. Add Statbotics client tests for TTL, stale fallback, locking, and pagination.
5. Add persistence/pipeline integration tests around the provider and Redis seams.
6. Add architecture checks for source ownership, central type declarations, and prohibited imports.
7. Add CI execution and document the local commands.

Each stage must leave the test suite runnable. Prefer a small set of high-value assertions over broad snapshots. Test names should state the invariant being protected.

## Completion criteria

- A documented, repeatable test command exists and runs in CI.
- TBA and Statbotics boundaries have deterministic contract coverage.
- Normalized schemas and data authority rules have executable tests.
- Important calculations have independently verified expected results.
- Source-to-destination behavior, Redis persistence, and failure paths are covered.
- Identity, missing-data, timezone, and freshness invariants are covered.
- Shared application types have an explicit central ownership policy and architecture checks prevent new random inline definitions.
- No test requires a live API, secret, or production Redis.
- The branch contains no unrelated feature, UI, refactor, or cleanup work.
