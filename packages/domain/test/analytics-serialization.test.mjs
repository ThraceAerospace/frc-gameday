import test from "node:test";
import assert from "node:assert/strict";

const roundTrip = (value) => JSON.parse(JSON.stringify(value));

const population = {
  population_key: "event-team-epa-change",
  total_count: 36,
  eligible_count: 32,
  excluded_count: 4,
};

test("metric result separates observation sample size from comparison coverage", () => {
  const metric = {
    metric_key: "epa-change",
    definition_version: "1",
    status: "available",
    value: 4.25,
    unit: "EPA",
    sample_size: 6,
    population: {
      population_key: "team-qual-match-epa",
      total_count: 8,
      eligible_count: 6,
      excluded_count: 2,
    },
    comparison: {
      population,
      rank_position: 4,
      rank_population: 32,
      percentile: 87.5,
    },
    baseline: {
      kind: "prior-event",
      event_key: "2026ctwat",
      event_name: "Waterbury",
      event_start_date: "2026-03-20",
      value: 112.4,
    },
    limitations: ["EPA is a model estimate, not a direct robot measurement."],
  };

  const received = roundTrip(metric);
  assert.deepEqual(received, metric);
  assert.equal(received.sample_size, 6);
  assert.equal(received.population.eligible_count, 6);
  assert.equal(received.comparison.population.eligible_count, 32);
  assert.equal(received.baseline.value, 112.4);
});

test("insufficient data is distinct from unavailable data and from numeric zero", () => {
  const insufficient = {
    metric_key: "peer-residual",
    definition_version: "1",
    status: "insufficient-data",
    value: null,
    unit: "points",
    sample_size: 2,
    population: {
      population_key: "peer-alliance-results",
      total_count: 12,
      eligible_count: 2,
      excluded_count: 10,
    },
    limitations: ["At least five peer alliance results are required."],
  };
  const unavailable = {
    ...insufficient,
    metric_key: "event-opr",
    status: "unavailable",
    sample_size: 0,
    population: {
      population_key: "event-team-opr",
      total_count: 36,
      eligible_count: 0,
      excluded_count: 36,
    },
  };
  const zero = { ...insufficient, metric_key: "zero-residual", status: "available", value: 0 };

  assert.equal(roundTrip(insufficient).status, "insufficient-data");
  assert.equal(roundTrip(unavailable).status, "unavailable");
  assert.equal(roundTrip(zero).value, 0);
  assert.equal(roundTrip(zero).status, "available");
});

test("findings preserve typed evidence, scope, and interpretation limitations", () => {
  const finding = {
    finding_key: "qualification-score-residual:2026arc_qm12:red",
    category: "score-residual",
    scope: "alliance",
    subject_key: "2026arc_qm12:red",
    severity: "high",
    title: "Large positive score residual",
    summary: "The alliance scored well above its pre-match prediction.",
    evidence: [{
      evidence_key: "score-residual",
      label: "Actual minus predicted score",
      value: 31,
      unit: "points",
      threshold: 20,
      sample_size: 18,
    }],
    suggested_action: "Review the match and webcast.",
    limitations: ["Alliance-level evidence does not identify individual robot contribution."],
  };

  assert.deepEqual(roundTrip(finding), finding);
  assert.equal(roundTrip(finding).scope, "alliance");
  assert.equal(roundTrip(finding).evidence[0].threshold, 20);
});
