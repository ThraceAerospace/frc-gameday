# Analytics redesign specification

FieldView analytics is organized around distinct investigations in addition to the event overview and matchup tools.

## Team Investigation — one selected team

Answer five questions for one team at a time:

1. Absolute strength: current Statbotics EPA and component estimates, event-relative percentile, and complementary TBA OPR/DPR/CCWM context. Do not compare raw values from different models as if they were the same scale.
2. Performance relative to expectations: compare alliance score residuals and win outcomes with pre-match Statbotics predictions. These are alliance-level observations, not isolated robot measurements.
3. Development: show match-level EPA snapshots within an event and Statbotics team-event snapshots across official events. A rating update is a model update, not direct proof of robot improvement.
4. Peer-relative performance: compare residuals from alliances involving the selected team with other alliances in the same event whose pre-match combined EPA is within ±20% of the selected alliance's strength. Require at least three selected-team matches and five peer alliance results. Label the result as alliance-level context.
5. Season anomaly/risk history: list unusual outcomes in matches involving the team across its season. Use robust median/MAD residual bands with at least eight scored observations; separately flag a loss after at least 80% model win probability. Include underperformance, overperformance, opponent anomalies, partners, opponents, event, phase, and match links. Count flagged matches and divide by evaluated matches. These are investigation leads, not causal determinations.

Only the selected team's full match history is requested by the browser. Event-roster data may support the current event peer comparison. The season-wide residual pattern also compares the selected alliance with opponents within ±20% pre-match combined EPA in the same matches. The browser must not fetch full match histories for every team.

## Qualification Analysis — event-wide match review

Include qualification matches only. Flag either alliance when its actual score residual is outside the robust event-calibrated band:

- Center: median qualification alliance residual.
- Spread: 1.4826 × MAD (median absolute deviation).
- Band: median ± max(20 points, 3 × spread).
- Minimum sample: eight scored alliance results.

Also flag a high-confidence winner miss when an alliance had at least 80% predicted win probability but lost. The score band is estimated from observed event errors; it is not a Statbotics-provided confidence interval. Rank high-confidence misses and extreme residuals for human review. Never infer disconnects, field faults, or robot failures from the score alone.

## Playoff Analysis — alliance and elimination performance

Keep elimination matches separate from qualification combinations. Group completed playoff results by the three-team alliance composition, summarize record and predicted-versus-actual score residuals, and show progression by elimination round.

For team season progression, calculate qualification-to-elimination residual shifts separately per event. An event is eligible with at least three scored qualification matches and two scored elimination matches with predictions. Each event contributes one shift so long playoff schedules do not dominate. A recurring-negative signal requires at least three eligible events, at least three negative shifts after positive qualification performance, and one-sided exact sign-test p ≤ 0.05. This is an exploratory alliance-level signal; partner and opponent strength are not fully adjusted, and it does not prove robot-level choking.

## Shared presentation contract

Every view follows takeaway → evidence → investigation. Show plain-language conclusions first, then relevant metrics and visualizations, then match/event evidence. Keep sample size, source coverage, model provenance, and caveats close to conclusions. Never attribute alliance residuals or shared EPA updates to an individual robot.

## Current implementation audit notes

This document defines intended analytical behavior; it is not proof that every calculation is already implemented in the server service layer. The first application audit identified these implementation gaps:

- Suggested Review still calculates model-upset, phase-specific median/MAD, large-residual, and high-alliance-EPA flags in the browser. These classifications should move into the server-side analytics service and become part of the EventAnalytics response.
- Event qualification anomaly calculations and the dashboard phase-band helper use the upper middle value for even-sized samples, while selected-team history uses the conventional average of the two middle values. Centralize and test one convention before changing thresholds or historical results.
- Selected-team season anomaly flags currently begin at four scored observations per side; the documented minimum is eight.
- The elimination-decline signal does not currently require positive qualification residual performance, although the specification defines the signal as a decline after positive qualification performance.
- The qualification prediction-calibration summary currently counts every incorrect winner prediction as an underdog win, including the 50/50 edge case. This is a miss count, not an underdog-win count; count an underdog win only when the actual winner's pre-match probability is strictly below 0.5.
- The selected-team match-analysis API route still contains substantial calculation logic instead of delegating to a reusable server-side service.
- The shared event-percentile helper reports the sole usable team in a one-observation cohort as the 100th percentile; insufficient peer coverage should be labeled insufficient or use an explicit one-sample convention.
- EPA contribution calculations discard an entire alliance when any team's pre-match EPA is negative, even when all values are present and the alliance total is positive. Negative EPA is a valid model value, not missing data.
- Statbotics stale-on-error fallbacks are not surfaced to the analytics consumers, and an explicit Event Analytics refresh can be skipped when the event job lock is held without returning an in-progress state.

See [APPLICATION-AUDIT.md](APPLICATION-AUDIT.md) for the corresponding findings and priorities. Keep this specification as the intended methodology while those implementation gaps are resolved.
