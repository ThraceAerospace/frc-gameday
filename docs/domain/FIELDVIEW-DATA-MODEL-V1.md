# FieldView Data Model v1

**Status:** Initial domain-model baseline  
**Date:** 2026-11-16  
**Reference fixture:** Archimedes Championship, Playoff 13 Match 1 (`2026arc_sf13m1`)

This document establishes the first iteration of FieldView's canonical domain model. It defines product-owned objects that correlate information from multiple providers. It is not a provider API schema and is not yet the versioned client DTO specification.

## 1. Core principles

1. FieldView owns its data model. Its shape is organized around the information the product provides, not around any one provider's API.
2. Provider payloads enter FieldView normalization unchanged. TBA, Statbotics, and every future provider retain their original values, field names, types, nullability, and nested structures.
3. Provider-specific types may be used by the backend domain to type fields that preserve provider data. They must not leak into client DTOs.
4. Correlation and association do not authorize mutation. For example, associating a TBA OPR value with a match team does not change the OPR value or make it a field from the TBA match endpoint.
5. Every FieldView-calculated value has a distinct, descriptive name and a documented formula, inputs, units, missing-data behavior, and version.
6. Every interpretation/flag exposes the evidence and thresholds that caused it. A label without its supporting values is insufficient.
7. No provider field may be silently renamed, converted, reinterpreted, defaulted, omitted, or overwritten. Any proposed transformation must be described and approved before implementation.
8. Missing, explicit null, zero, stale, unavailable, and failed acquisition remain distinguishable.
9. Source provenance and freshness are internal machine-readable metadata. They do not dictate the public product model's nesting.
10. The client contract is a separate, explicit, serializable, provider-independent representation derived from the domain model.

## 2. Canonical objects and responsibilities

| Object | Responsibility |
| --- | --- |
| `FieldViewTeam` | Team identity and stable team information |
| `FieldViewTeamSeason` | Season-scoped team information and season statistics |
| `FieldViewEvent` | Event identity, schedule, location, and event information |
| `FieldViewEventTeam` | A team's participation and event-specific status/statistics |
| `FieldViewMatch` | Match information, predictions, team associations, playoff associations, analysis, and flags |
| `FieldViewPlayoffAlliance` | Official playoff alliance identity, members, backup, and progression information |
| `FieldViewEventAnalytics` | Event-wide calculations, comparisons, distributions, and findings |
| `FieldViewTeamAnalytics` | Team-specific calculations and historical comparisons |

These are domain objects, not Durable Object boundaries. The initial runtime candidate remains one EventRuntime per event.

## 3. FieldViewMatch v1

The match is the first detailed model because it demonstrates the value of combining provider data.

### 3.1 Original TBA match fields

`FieldViewMatch` retains the complete TBA match field set with the exact generated TBA types. The current type implementation expresses this as an interface extending `TBAMatch`, rather than redefining TBA fields using generic types. Statbotics-derived fields similarly reference provider-owned types. This is a backend domain dependency only; the client DTOs will define their own serializable types.

This preserves, among other fields:

- `key`, `event_key`, `comp_level`, `set_number`, and `match_number`;
- `alliances`, including team keys, scores, surrogate keys, and DQ keys;
- `winning_alliance`, `score_breakdown`, and `videos`;
- `time`, `actual_time`, `predicted_time`, and `post_result_time`.

No field is weakened to a generic `string`, `number`, or other approximation when a provider type already exists.

### 3.2 Statbotics match information

The FieldView model represents Statbotics information that adds meaning beyond the TBA match record:

- Statbotics match name, status, and elimination/week context;
- Statbotics prediction, kept distinct from TBA's prediction;
- Statbotics result, preserving the complete result structure;
- Statbotics alliance data and numeric team identifiers where needed to retain source meaning;
- per-team pre-match and post-match EPA records.

Statbotics team IDs remain numeric. TBA team keys remain strings such as `frc7407`. A FieldView association may relate the two, but must not replace either source representation.

### 3.3 Independent predictions

Predictions are separate first-class concepts:

- `predictions.tba` is the match entry from TBA's event-predictions endpoint, indexed by match key.
- `predictions.statbotics` is Statbotics' `pred` object.

They may agree, disagree, or be unavailable independently. Neither is selected as a silent replacement for the other.

The generated TBA OpenAPI currently models the event-predictions response too loosely to serve as the typed per-match prediction contract. The provider package must define a provider-owned type from the actual endpoint response shape before the domain field is implemented. Do not use `Record<string, unknown>` or an untyped data bag as a shortcut.

### 3.4 Team associations

The model associates each match alliance's teams with their additional statistics while retaining the original TBA `alliances` field unchanged.

Each `FieldViewMatchTeam` association includes:

- the unchanged TBA team key;
- the unchanged numeric Statbotics team ID when a source association is available;
- TBA event-level OPR, DPR, and CCWM values when available;
- Statbotics pre-match EPA and post-match EPA records when available.

The association arrays follow the corresponding TBA alliance roster order. The Statbotics numeric ID is optional when the Statbotics match record or an explicit cross-source association is unavailable. Do not derive it by parsing or stripping the `frc` prefix from a TBA key. The association rule must preserve both original identifiers. Missing metrics remain missing; they are never represented as zero.

OPR/DPR/CCWM originate from the TBA event-level OPR resource, not from the match endpoint. Fetch/cache that event resource at event scope and associate its values with the teams. Do not fetch it separately for every match.

### 3.5 Explicit FieldView analysis

The first analysis fields are:

- alliance actual score;
- alliance predicted score;
- score delta;
- alliance pre-match EPA total;
- alliance post-match EPA total.

Definitions:

- Actual score is the original TBA alliance score and retains the exact TBA score field type.
- Predicted score is the original Statbotics predicted alliance score and retains the exact Statbotics prediction field type.
- Score delta is actual score minus predicted score, represented only when both inputs are numeric. An unavailable prediction remains absent; an explicit provider null remains null. The derived delta is not calculated from missing or null inputs.
- Alliance EPA totals are the sum of the three associated team EPA values for the relevant time point.

An aggregate is unavailable unless all required team values are present. Missing values are not treated as zero. These calculations are FieldView-owned and do not modify the provider fields.

### 3.6 Flags and evidence

The match exposes a match-level prediction interpretation and alliance-level flags. Initial existing labels include:

- Lean/Strong Red or Blue and Toss-up;
- Predicted Win / Predicted Loss;
- High Alliance EPA;
- Large Score Delta.

Each flag must include typed evidence, including the values, event threshold, and sample size used to trigger it. Event-wide thresholds must be calculated from the eligible event population and must not be guessed from an isolated match.

The currently deployed definitions are documented in the analytics source and must be verified against that implementation before they are migrated. This model document does not silently redefine their thresholds.

### 3.7 Playoff alliance association

For playoff matches, FieldView associates the red and blue match alliances with their corresponding official `FieldViewPlayoffAlliance` objects.

The association is resolved server-side and reused across matches. Investigate TBA's playoff alliances and playoff advancement endpoints to determine the most reliable source for alliance identity and progression across playoff formats.

The match association distinguishes:
- not yet acquired/unknown association;
- a known non-playoff match;
- a playoff match for which an alliance association is unavailable;
- a successfully associated alliance.

The client must not need to query the playoff alliances endpoint for each match.

## 4. Other domain objects

### FieldViewTeam

Retains the TBA team fields and exact types. Additional FieldView-owned team-level fields are added only when their source and meaning are defined.

### FieldViewTeamSeason

Represents a team and season together. It may associate Statbotics season data and other season-scoped information without changing the original team or provider values.

### FieldViewEvent

Retains the TBA event fields and exact types, including the original nullable timezone. Event timezone presentation rules do not authorize changing the stored provider value or inventing a fallback.

### FieldViewEventTeam

Represents a team's participation in an event. It is the reusable home for event-specific team status and event-level metrics such as OPR/DPR/CCWM. Match objects may associate those values with the teams participating in a particular match.

### FieldViewPlayoffAlliance

Represents the official alliance, including the original TBA elimination-alliance fields and separately named FieldView associations/progression information where needed.

### FieldViewEventAnalytics and FieldViewTeamAnalytics

Expose calculated results with explicit metric identity/version, value and unit, eligible population, sample size, comparison coverage, and interpretation limitations. Analytics are descriptive evidence, not causal determinations.

## 5. Provenance and freshness

Source metadata is internal and records, at minimum:

- provider and endpoint/resource identity;
- acquisition outcome;
- retrieval time;
- source freshness or staleness where known;
- source version/ETag or equivalent validator when available.

Metadata must be specific enough to distinguish TBA match data from TBA event predictions, TBA event OPRs, TBA playoff information, and Statbotics match data. A failed refresh must not erase previously valid data.

## 6. Provider overlaps and deliberate deduplication

The Archimedes SF13 example demonstrates identical or overlapping fields across providers:

| Information | TBA | Statbotics | v1 treatment |
| --- | --- | --- | --- |
| Match key | `key` | `key` | One canonical match identity; record both source observations in provenance |
| Event key | `event_key` | `event` | TBA event key is canonical identity; retain Statbotics source value internally |
| Competition level | `comp_level` | `comp_level` | TBA field remains canonical; record matching/contradictory Statbotics observation |
| Set/match number | `set_number`, `match_number` | Same concepts | TBA fields remain canonical; Statbotics source observations remain available internally |
| Match timestamp | `time` | `time` | Same value in the supplied example; no need to publish a duplicate field |
| Predicted timestamp | `predicted_time` | `predicted_time` | Same value in the supplied example; no need to publish a duplicate field |
| Actual score | Alliance scores / score breakdown | `result` | Preserve TBA match fields and Statbotics result independently |
| Winner | `winning_alliance` | `result.winner` | Preserve both source observations; do not overwrite one with the other |
| Video | `videos` | `video` | Preserve TBA video structure; record Statbotics observation/provenance |
| Alliance membership | String team keys | Numeric team IDs | Preserve both representations; associate explicitly |
| Predictions | Event-predictions endpoint | `pred` | Keep as independent predictions |
| EPA | Not supplied by TBA match | `pre_epas` / `epas` | Associate with the relevant teams |
| OPR/DPR/CCWM | Event OPR endpoint | Not supplied by this Statbotics match response | Associate TBA values with event teams and match teams |

A matching value does not prove that one provider field can be deleted from source records. If the client contract publishes only one canonical value for a duplicated fact, the contract documentation must say which source owns that value and how the other source observation remains available for diagnostics/provenance.

## 7. Source-record retention and deliberate omissions

Passing a provider payload unchanged into normalization does not mean every provider field must be copied into the client-facing FieldView object. It does mean the original payload must not be silently altered or discarded during ingestion.

The backend must retain the original provider source records (or an equivalently lossless representation) separately from the assembled FieldView product object. This preserves fields that are not currently needed by the product model and permits later model expansion without another provider fetch. Source records are internal and are not automatically serialized to clients.

For the Archimedes Statbotics match, the source record contains:

- identity/context: `key`, `year`, `event`, `week`, `elim`, `comp_level`, `set_number`, `match_number`, `match_name`;
- timing/status/media: `time`, `predicted_time`, `status`, `video`;
- `alliances`, `pred`, and the complete `result` object;
- the complete `pre_epas` and `epas` maps, including component fields such as `comp_0_epa` through `comp_9_epa`.

The FieldView product object exposes the distinct information it needs as named fields and team associations. Statbotics values that duplicate TBA identity, timestamps, or video information need not be repeated as duplicate client fields, but their original observations remain in the internal Statbotics source record and source metadata. The complete Statbotics result and prediction information remain represented as separately sourced values.

The TBA match object retains all of its original fields directly. TBA event predictions and TBA event OPRs are separate source records; their associated values are represented in the match/team product objects without pretending they originated in the TBA match response.

Any field omitted from a client DTO must be listed in the client-contract documentation with the reason for omission. Omission from a DTO is not permission to delete or mutate the internal provider source record.

## 8. Client contract boundary

The domain model is backend-oriented and may use provider types for pass-through fields. The versioned client contract is a separate package and must:

- contain explicit serializable FieldView DTO types;
- not import TBA or Statbotics types;
- expose FieldView concepts, associations, calculations, and flag evidence;
- define deliberate omission of provider fields not needed by clients;
- distinguish missing, null, zero, stale, and unavailable values;
- be versioned when its meaning or structure changes.

The client contract is the next implementation step after this domain baseline is reviewed. This document does not authorize publishing provider schemas directly.

## 9. Implementation sequence

1. Complete and typecheck the initial domain type definitions and source metadata types.
2. Keep provider-owned typing for the TBA event-predictions response in the TBA package, based on the supplied endpoint response shape.
3. Add the Archimedes SF13 fixture and verify every source field, association, overlap, calculation, flag, and playoff relationship.
4. Define the versioned client DTOs separately.
5. Add validation and fixture-driven tests.
6. Only then migrate acquisition/reconciliation and consumers.

No provider calculations, endpoint acquisition, or runtime implementation is authorized by defining these types alone.
