# FieldView analytics domain result contract

**Status:** M3 domain contract  
**Scope:** Result semantics and serialization; not calculation implementations or UI layout.

## Design goals

Analytics results must be understandable without consulting a provider-specific response or guessing what a count means. The domain contract separates:

- metric observations from the population those observations came from;
- calculation coverage from peer-comparison coverage;
- insufficient evidence from unavailable source data;
- prior-event baselines from the current value;
- machine-readable evidence from the human-readable finding;
- the scope of an observation from any interpretation about an individual team.

The domain package defines these types only. Provider acquisition, metric calculation, cohort construction, and refresh lifecycle remain owned by their respective runtime/service layers.

## Metric result

Every FieldViewMetricResult identifies a stable metric_key and a definition_version. A changed formula, eligibility rule, or interpretation that changes the meaning of a metric requires a new definition version.

A metric has an explicit status:

| Status | Meaning |
| --- | --- |
| available | The metric was calculated under its definition and has a numeric value. Zero is a valid value. |
| insufficient-data | Some usable observations exist, but the definition's minimum sample/coverage requirements are not met. |
| unavailable | The required source data or acquisition is unavailable, so the metric cannot be calculated. |

A metric with insufficient-data or unavailable has value: null; it must not be represented as zero. Pending acquisition is a lifecycle state and is not a metric-result status: do not publish a completed metric result merely to represent work that has not run.

sample_size is the number of observations actually used in the calculation. It is not the number of teams at the event and is not the comparison denominator.

## Population and coverage

FieldViewAnalyticsPopulation describes one named population:

- total_count: all observations/subjects in the population definition;
- eligible_count: observations/subjects meeting the metric's inclusion rules;
- excluded_count: those excluded by those rules.

The counts must satisfy total_count = eligible_count + excluded_count. Do not include missing-history teams in an improvement ranking as zero; they remain part of the event roster but are excluded from the eligible ranking population.

A metric's population describes the observations used to calculate it. Its optional comparison.population describes the peer cohort used for rank or percentile. These are deliberately independent. For example, a team's EPA change may use six match observations while its event comparison ranks 32 teams with usable prior-event baselines out of a 36-team event roster.

The optional comparison contains a one-based rank and the eligible rank denominator. Percentile is nullable: do not label a one-team cohort as the 100th percentile. If the cohort is too small for a meaningful percentile, leave it null. Never infer the rank denominator from the number of event teams or from the number of observations used in the metric.

## Prior-event baseline

A change metric may include a FieldViewAnalyticsBaseline identifying the prior event and its value. For event-level team development comparisons, each event-roster team uses its own most recent prior event as its baseline; teams without usable prior history remain in the event view but are excluded from the change ranking. Competitor baselines need not come from the same event.

This preserves the distinction between the team's prior-event baseline, its current metric value, its calculated change, and its position among teams with usable change data.

A model update or EPA change is descriptive evidence, not proof of robot improvement.

## Findings and evidence

A FieldViewAnalyticsFinding is a server-generated review prompt with a stable key, category, explicit scope, severity, evidence, suggested action, and limitations. Evidence uses typed numeric values, units, and optional thresholds/sample/population metadata; it is not only a list of display strings.

Scopes are match, alliance, team, or event. Alliance residuals, shared EPA updates, and match outcomes must remain alliance/match-level observations. They must not be promoted to claims about an individual robot. Findings are investigation leads, not causal determinations.

The client presents findings as authored by the server. It may format the evidence, but it must not independently recalculate thresholds or invent a finding from raw provider data.

## Serialization

These analytics objects are canonical FieldView domain objects. HTTP and WebSocket transport serialize them directly; no parallel analytics DTO or client-side semantic model is introduced. JSON round trips preserve numeric zero, explicit null, absent optional fields, coverage counts, baseline identity, and typed finding evidence.
