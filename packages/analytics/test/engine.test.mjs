import test from "node:test";
import assert from "node:assert/strict";
import {
  AnalyticsEngine,
  AnalyticsExecutionError,
  AnalyticsOperationRegistry,
} from "../src/engine.ts";
import { FIELDVIEW_ANALYTICS_DEFINITIONS } from "../src/definitions.ts";
import { createFieldViewAnalyticsEngine, createFieldViewAnalyticsOperationRegistry } from "../src/operations.ts";

const definition = {
  definition_key: "test-metric",
  version: "2.1.0",
  name: "Test metric",
  description: "Test-only metric",
  scope: "event",
  operation_key: "sum-values",
  inputs: [
    { input_key: "values", source_path: "input.values", required: true, description: "Values", unit: "points" },
    { input_key: "optional", source_path: "input.optional", required: false, description: "Optional", unit: "points" },
  ],
  population: { population_key: "test-population", inclusion_rules: [], exclusion_rules: [] },
  formula: { expression: "sum(values)", steps: [] },
  output_unit: "points",
  interpretation_rules: [],
  limitations: [],
};

test("registered operation executes from resolved inputs and preserves definition version", async () => {
  const registry = new AnalyticsOperationRegistry([{
    operation_key: "sum-values",
    execute: (_context, inputs) => inputs.values.reduce((sum, value) => sum + value, 0),
  }]);
  const engine = new AnalyticsEngine([definition], registry);
  const result = await engine.execute({
    definition_key: "test-metric",
    context: {},
    resolved_inputs: { values: [2, 3, 5] },
  });
  assert.deepEqual(result, {
    definition_key: "test-metric",
    definition_version: "2.1.0",
    operation_key: "sum-values",
    status: "succeeded",
    value: 10,
    warnings: ["Optional input unavailable: optional"],
  });
});

test("engine rejects missing required inputs before executing an operation", async () => {
  let executed = false;
  const registry = new AnalyticsOperationRegistry([{
    operation_key: "sum-values",
    execute: () => { executed = true; return 0; },
  }]);
  const engine = new AnalyticsEngine([definition], registry);
  await assert.rejects(
    engine.execute({ definition_key: "test-metric", context: {}, resolved_inputs: {} }),
    (error) => error instanceof AnalyticsExecutionError && error.code === "missing-required-input",
  );
  assert.equal(executed, false);
});

test("engine rejects unknown definitions and unregistered operations", async () => {
  const registry = new AnalyticsOperationRegistry([{
    operation_key: "sum-values", execute: () => 0,
  }]);
  const engine = new AnalyticsEngine([definition], registry);
  await assert.rejects(
    engine.execute({ definition_key: "missing", context: {}, resolved_inputs: {} }),
    (error) => error.code === "unknown-definition",
  );
  assert.throws(
    () => new AnalyticsEngine([definition], new AnalyticsOperationRegistry()),
    (error) => error.code === "unknown-operation",
  );
});

test("registry rejects duplicate keys and definitions cannot contain executable expressions", () => {
  const registry = new AnalyticsOperationRegistry([{ operation_key: "sum-values", execute: () => 0 }]);
  assert.throws(
    () => registry.register({ operation_key: "sum-values", execute: () => 1 }),
    (error) => error.code === "duplicate-operation",
  );
  assert.equal(FIELDVIEW_ANALYTICS_DEFINITIONS.every((item) => typeof item.operation_key === "string"), true);
  assert.equal(FIELDVIEW_ANALYTICS_DEFINITIONS.some((item) => "execute" in item), false);
});

test("default FieldView registry covers every operation in the versioned definition catalog", () => {
  const registry = createFieldViewAnalyticsOperationRegistry();
  const engine = createFieldViewAnalyticsEngine();
  assert.deepEqual(
    registry.keys(),
    [...new Set(FIELDVIEW_ANALYTICS_DEFINITIONS.map((item) => item.operation_key))].sort(),
  );
  assert.ok(engine);
});

test("default engine invokes the registered alliance calculation without evaluating source paths", async () => {
  const engine = createFieldViewAnalyticsEngine();
  const result = await engine.execute({
    definition_key: "alliance-score-residual",
    context: {
      records: [{
        match: {
          key: "2026test_qm1", comp_level: "qm", set_number: 1, match_number: 1,
          winning_alliance: "red",
          alliances: {
            red: { team_keys: ["frc1", "frc2", "frc3"], score: 101 },
            blue: { team_keys: ["frc4", "frc5", "frc6"], score: 95 },
          },
        },
        statbotics: { pred: { red_score: 96, blue_score: 98 } },
        statboticsStatus: "ready",
      }],
    },
    resolved_inputs: { "actual-score": 101, "predicted-score": 96 },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.definition_version, "1.0.0");
  assert.equal(result.value[0].residual, 5);
  assert.equal(result.value[1].residual, -3);
});
