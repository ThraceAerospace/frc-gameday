# Historical Team 3461 fixtures

`team3461-full-2026-events.part1.b64` and `part2.b64` concatenate to a gzip-compressed JSON fixture used by `historical-team3461-parity.test.mjs`.

The fixture is derived from the uploaded 2026 cohort archive:
- CTHAR: all 89 TBA match records and their 89 Statbotics match predictions; Team 3461 appears in 15 matches.
- MAWNE: all 91 TBA match records and their 91 Statbotics match predictions; Team 3461 appears in 14 matches.
- The fixture retains the complete event match population and alliance scores/predictions, plus Team 3461's available per-match EPA maps.
- Team 3461's archived Statbotics team-event records provide the CTHAR comparison against prior MAWNE: EPA 14.70 to 45.72 (+31.02).

The test validates event-level alliance, qualification, anomaly, playoff, and finding outputs against the direct calculation implementations, then validates Team 3461's team-event investigation and season comparison against those same implementations.

This is deliberately a focused historical parity fixture, not a complete all-team ranking fixture: only Team 3461's team metadata/EPA history is included, so the test does not claim to validate every team's event percentile, OPR/DPR/CCWM row, or cohort-wide comparison rank. Missing team data is not represented as zero.
