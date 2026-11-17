# FieldView Data Model v1

**Status:** Initial domain-model baseline; canonical event snapshot composition implemented  
**Date:** 2026-11-16  
**Reference fixture:** Archimedes Championship, Playoff 13 Match 1 (`2026arc_sf13m1`)

This document establishes the first iteration of FieldView's canonical domain model. It defines product-owned objects that correlate information from multiple providers. It is not a provider API schema. These domain objects are the application data model used by backend and client; transport serialization does not introduce a second semantic model.

## 1. Core principles

1. FieldView owns its data model. Its shape is organized around the information the product provides, not around any one provider's API.
2. Provider payloads enter FieldView normalization unchanged. TBA, Statbotics, and every future provider retain their original values, field names, types, nullability, and nested structures.
3. Provider-specific types may be used by the domain to type fields that preserve provider data. The client consumes the serialized FieldView domain shape, not provider clients or provider acquisition implementations.
4. Correlation and association do not authorize mutation. For example, associating a TBA OPR value with a match team does not change the OPR value or make it a field from the TBA match endpoint.
5. Every FieldView-calculated value has a distinct, descriptive name and a documented formula, inputs, units, missing-data behavior, and version.
6. Every interpretation/flag exposes the evidence and thresholds that caused it. A label without its supporting values is insufficient.
7. No provider field may be silently renamed, converted, reinterpreted, defaulted, omitted, or overwritten. Any proposed transformation must be described and approved before implementation.
8. Missing, explicit null, zero, stale, unavailable, and failed acquisition remain distinguishable.
9. Source provenance and freshness are internal machine-readable metadata. They do not dictate the public product model's nesting.
10. The canonical domain objects are the shared application data model. Their transport representation is ordinary serialization of those objects, not a separately maintained DTO model.

## 2. Canonical objects and responsibilities

| Object | Responsibility |
| --- | --- |
| `FieldViewTeam` | Team identity and stable team information |
| `FieldViewTeamSeason` | Season-scoped team information and season statistics |
| `FieldViewEvent` | Event identity, schedule, location, and event information |
| `FieldViewEventSnapshot` | Canonical event-scoped aggregate of event, teams, event-team associations, matches, and playoff alliances |
| `FieldViewEventTeam` | A team's participation and event-specific status/statistics |
| `FieldViewMatch` | Match information, predictions, team associations, playoff associations, analysis, and flags |
| `FieldViewPlayoffAlliance` | Official playoff alliance identity, members, backup, and progression information |
| `FieldViewEventAnalytics` | Event-wide calculations, comparisons, distributions, and findings |
| `FieldViewTeamAnalytics` | Team-specific calculations and historical comparisons |

These are domain objects, not Durable Object boundaries. The initial runtime candidate remains one EventRuntime per event.

## 3. FieldViewMatch v1

The match is the first detailed model because it demonstrates the value of combining provider data.

### 3.1 Original TBA match fields

`FieldViewMatch` retains the complete TBA match field set with the exact generated TBA types. The current type implementation expresses this as an interface extending `TBAMatch`, rather than redefining TBA fields using generic types. Statbotics-derived fields similarly reference provider-owned types. These are type-level dependencies for unchanged source fields; provider clients, API acquisition, and infrastructure implementations are not part of the client data path.

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
- Statbotics alliance data, retained under its explicitly named source field;
- per-team pre-match and post-match EPA records.

Statbotics team IDs remain numeric. TBA team keys remain strings such as `frc7407`. A FieldView association may relate the two, but must not replace either source representation.

### 3.3 Independent predictions

Predictions are separate first-class concepts:

- `predictions.tba` is the match entry from TBA's event-predictions endpoint, indexed by match key.
- `predictions.statbotics` is Statbotics' `pred` object.

They may agree, disagree, or be unavailable independently. Neither is selected as a silent replacement for the other.

The generated TBA OpenAPI currently models the event-predictions response too loosely to serve as the typed per-match prediction contract. The TBA provider package now defines `TBAEventMatchPrediction` and `TBAEventPredictions` from the supplied endpoint response shape. These remain provider-owned types used by the domain to preserve the endpoint's source shape; do not replace them with `Record<string, unknown>` or an untyped data bag.

### 3.4 Team associations

The model associates each match alliance's teams with their additional statistics while retaining the original TBA `alliances` field unchanged. Each provider-backed aggregate carries resource-specific `sources` metadata; a missing metadata key means no acquisition state has been recorded, not that the resource is unavailable.

Each `FieldViewMatchTeam` association includes:

- the unchanged TBA team key;
- the official TBA `team_number` when the corresponding TBA team record is available;
- TBA event-level OPR, DPR, and CCWM values when available;
- Statbotics pre-match EPA and post-match EPA records when available.

The association arrays follow the corresponding TBA alliance roster order. TBA match alliance rosters provide string team keys, while TBA team records provide the official numeric `team_number`. That TBA `team_number` is compared directly with Statbotics' numeric `team` value and is stringified only to index Statbotics' string-keyed EPA maps. Do not parse or strip the `frc` prefix from a team key, and do not introduce a redundant `statbotics_team_id` field. Preserve the TBA `team_number` and Statbotics source values unchanged. Missing team metadata or metrics remain missing; they are never represented as zero.

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

For playoff matches, FieldView associates the red and blue match alliances with their corresponding official `FieldViewPlayoffAlliance` objects by exact name. The match's unchanged TBA team keys are joined to the canonical `FieldViewEventTeam` records, and two distinct match teams reporting the same non-null `tba_status.alliance.name` are sufficient to identify that side's alliance by matching it to the elimination-alliance `name`. TBA documents the status alliance name as nullable, so a missing or null name cannot be used for association. Duplicate matching alliance names or ambiguous team status data remain unresolved. Response order and alliance numbering are never used as fallback identity. This also handles matches containing either the incoming or outgoing team from a recorded backup substitution.

The association is resolved server-side as soon as the match is normalized and reused across matches. The client does not query the playoff alliances endpoint for each match.

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

`FieldViewTeamSeason` pairs an unchanged TBA `team_key` and official TBA `team_number` with the FieldView season `year`. The TBA `team_number` is sufficient to correlate Statbotics' numeric `team` value; no additional Statbotics identity field is needed. The Statbotics team-year record is retained unchanged, and a supplied record must have a `team` value equal to the TBA `team_number` or normalization rejects the mismatch.

### FieldViewEvent

Retains the TBA event fields and exact types, including the original nullable timezone. Event timezone presentation rules do not authorize changing the stored provider value or inventing a fallback.

`normalizeFieldViewTeamSeason` composes this object from the unchanged TBA team key, TBA team number, season year, and optional unchanged Statbotics team-year record. It correlates by equality between TBA `team_number` and Statbotics `team`, rejects mismatched records, and does not parse the TBA key or rewrite provider values. Fixture tests cover successful correlation, mismatch rejection, retained explicit nulls, and JSON round-trip behavior.

### FieldViewEventTeam

Represents a team's participation in an event. It is the reusable home for event-specific team status and event-level metrics such as OPR/DPR/CCWM. `normalizeFieldViewEventTeam` composes this object from the unchanged event/team identifiers, optional TBA team-event status, and event-level OPR resource. It associates OPR/DPR/CCWM by the original TBA team key; it does not transform the source values. Explicit null status is retained, while absent status and absent metric entries remain absent. Match objects may associate those values with the teams participating in a particular match.

### FieldViewPlayoffAlliance

Represents the official alliance, including the original TBA elimination-alliance fields and separately named FieldView associations/progression information where needed.

### FieldViewEventAnalytics and FieldViewTeamAnalytics

Expose calculated results with explicit metric identity/version, value and unit, eligible population, sample size, comparison coverage, and interpretation limitations. Analytics are descriptive evidence, not causal determinations.

## 5. Provenance and freshness

Source metadata is internal and records, at minimum:

- provider and endpoint/resource identity;
- availability state;
- retrieval time of the retained payload version;
- source freshness or staleness where known;
- source version/ETag or equivalent validator when available.

The `sources` metadata is attached to each aggregate that depends on acquired provider resources: `FieldViewTeam` tracks `tba_team`; `FieldViewEvent` tracks `tba_event`; `FieldViewTeamSeason` tracks `tba_team` and `statbotics_team_year`; `FieldViewEventTeam` tracks `tba_team_event_status` and `tba_event_oprs`; `FieldViewMatch` tracks match, prediction, OPR, team-correlation, and Statbotics resources; and `FieldViewPlayoffAlliance` tracks playoff-alliance and advancement resources. `FieldViewSourceMetadata` includes `tba_team`, `tba_teams`, and `tba_event` in addition to the resource keys listed above.

The `FieldViewSourceStatus` meanings are precise:

- `available`: the retained resource version is current and `retrieved_at` identifies that version;
- `stale`: a previously usable version is retained but is not current, including when a refresh failed; `retrieved_at` identifies the older retained version;
- `unavailable`: the provider authoritatively indicates that the resource is not available and no usable version is retained;
- `failed`: acquisition failed and no usable retained version exists.

The TypeScript metadata type is a discriminated union: `available` and `stale` require a non-null `retrieved_at`; `unavailable` and `failed` require `retrieved_at: null`. This prevents contradictory status/timestamp combinations in typed domain code. An absent metadata entry means no acquisition state has been recorded; it is not equivalent to `unavailable`, `failed`, or a null resource value. A failed refresh must not erase previously valid data; when an older usable version remains, its status is `stale`, not `failed`. Metadata keys distinguish TBA match data from TBA event predictions, TBA event OPRs, TBA playoff information, and Statbotics match data.

The match competition levels `pm` (practice) and `qm` (qualification) are known non-playoff matches and therefore carry `playoff_alliances: null`. Elimination levels `ef`, `qf`, `sf`, and `f` are playoff matches: their alliance association is absent until both required source resources have been acquired, then contains the exact-name associations or explicit nulls when the association cannot be resolved.

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
| Alliance membership | String team keys | Numeric team values | Preserve both source representations; correlate through TBA team records' official `team_number` |
| Predictions | Event-predictions endpoint | `pred` | Keep as independent predictions |
| EPA | Not supplied by TBA match | `pre_epas` / `epas` | Associate with the relevant teams |
| OPR/DPR/CCWM | Event OPR endpoint | Not supplied by this Statbotics match response | Associate TBA values with event teams and match teams |

A matching value does not prove that one provider field can be deleted from source records. If a serialized FieldView object exposes only one canonical value for a duplicated fact, the domain documentation must say which source owns that value and how the other source observation remains available for diagnostics/provenance.

## 7. Provider payload caching, versioning, and deliberate omissions

Complete provider payload retention belongs to the ingestion/cache/versioning layer, not to each FieldView domain object.

- Every provider payload accepted by FieldView is cached and versioned in its complete ingested form.
- Ingestion preserves the provider payload: field names, values, types, nullability, and nested structures are not silently changed, omitted, or overwritten.
- A newer response creates a new version; it does not silently replace the only retained copy of an earlier version.
- The cache/version store is responsible for retaining and retrieving complete provider payload versions. Its retention duration, eviction policy, and version-selection rules are separate infrastructure decisions.
- FieldView domain objects and their serialized representations are aggregates. They select and associate explicitly typed values from the relevant versioned provider inputs and add separately named FieldView-owned values where approved.
- Constructing an aggregate does not mutate any cached provider payload.
- Do not add a generic `raw` or `sourceRecords` property to every domain object merely to repeat data already owned by the ingestion/cache layer.
- Provider payloads and their versions are backend inputs. They are not automatically serialized to clients.

For the Archimedes SF13 Match 1 example, the complete TBA match response, Statbotics match response, TBA event-predictions response, TBA event OPR response, and TBA team records used for numeric team correlation are independently retained/versioned resources. The FieldView match/team aggregates may select values from these resources, while retaining the distinction between their source endpoints.

In particular:

- The complete Statbotics match payload remains available in its versioned source record, including identity/context, timing/status/media, alliances, prediction, result, and complete `pre_epas` and `epas` maps.
- The complete TBA match payload remains available in its versioned source record, including alliances, score breakdown, videos, and all match timestamps.
- TBA event predictions remain a separate versioned resource indexed by the unchanged TBA match key.
- TBA OPR/DPR/CCWM remain sourced from the separate event-level OPR resource and are associated with event teams and match teams without being reclassified as match-endpoint fields.

A FieldView aggregate need not duplicate every provider field. Any omission from an aggregate must be deliberate and documented. Omission from an aggregate never authorizes deletion or mutation of the cached provider payload.

## 8. Domain objects and transport serialization

The canonical FieldView domain objects are the application data model shared by backend and client. Do not create a parallel DTO package that duplicates their fields or semantics.

- HTTP responses, WebSocket snapshots, and other client messages serialize the relevant FieldView domain objects directly.
- Serialization is a transport operation, not a second normalization or interpretation stage. It must not rename, convert, default, or discard domain values.
- The serialized representation must preserve explicit `null` values and distinguish them from absent properties. Optional properties that are absent remain absent; they must not be filled with invented defaults.
- The current domain fields use JSON-compatible primitives, arrays, and objects. Round-trip tests cover representative Team, Event, TeamSeason, EventTeam, Match, PlayoffAlliance, and EventSnapshot objects, including provenance and nested nullable fields. Analytics round-trip coverage is deferred until its result semantics have been reviewed; this does not authorize changing the analytics model as part of serialization work.
- If a future domain field cannot be represented by the chosen transport, document the concrete incompatibility and solve it at that field or transport boundary. Do not introduce a duplicate model preemptively.
- Provider payload retention and version history remain responsibilities of ingestion/storage. A client receives the relevant FieldView domain aggregate, not an automatic dump of every cached provider record.

Versioning applies to the FieldView domain model and its serialized representation. A change to field meaning or structure must be reviewed and documented as a domain-model version change; a separate DTO version is not maintained.

## 9. Implementation sequence

1. Complete and typecheck the initial domain type definitions and source metadata types.
2. Keep provider-owned typing for the TBA event-predictions response in the TBA package, based on the supplied endpoint response shape.
3. Add the Archimedes SF13 source fixture. The fixture includes the complete supplied TBA match and Statbotics match payloads, the exact TBA event-prediction entry for `2026arc_sf13m1`, and the event-level OPR/DPR/CCWM values.
4. Implement and test `normalizeFieldViewMatch` as a pure association boundary, retaining provider payloads and correlating Statbotics team values through TBA team_number.
5. Implement and test `normalizeFieldViewEventTeam` for event-team status and event-level OPR/DPR/CCWM association by unchanged TBA team key.
6. Verify that canonical domain objects serialize and round-trip without changing source values, explicit nulls, or absent fields; add fixture-driven tests.
7. Compose FieldViewEventSnapshot from TBA event, team, status, OPR, match, prediction, and playoff-alliance resources. The pure domain normalizer and the first EventRuntime snapshot adapter are implemented; Statbotics enrichment, publication, and client consumers remain pending.

The fixture is a set of five independent provider-resource inputs, not a pre-merged `FieldViewMatch`. Complete provider responses and their versions remain the responsibility of the ingestion/cache layer. Defining a domain type or fixture alone does not authorize provider calculations, analytics changes, or client publication.
