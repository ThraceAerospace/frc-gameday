import test from "node:test";
import assert from "node:assert/strict";
import { createAnalyticsAudit } from "../src/audit.ts";

test("audit digest is stable across input object key ordering", async () => {
  const base = {
    calculation_id: "calc-1",
    calculated_at: 100,
    definition_keys: ["alliance-score-residual"],
    inputs: [{
      input_key: "matches", provider: "tba", resource: "matches",
      source_revision: 2, fetched_at: 90, record_count: 3,
      included_count: 2, excluded_count: 1, status: "partial",
    }],
  };
  const first = await createAnalyticsAudit(base);
  const second = await createAnalyticsAudit({
    ...base,
    inputs: [{ ...base.inputs[0] }],
  });
  assert.equal(first.input_digest, second.input_digest);
  assert.equal(first.definition_versions[0].version, "1.0.0");
  assert.equal(first.inputs[0].excluded_count, 1);
});

test("audit refuses unknown calculation definitions", async () => {
  await assert.rejects(
    createAnalyticsAudit({
      calculation_id: "calc-2", calculated_at: 100, inputs: [],
      definition_keys: ["not-registered"],
    }),
    /Unknown analytics definition/,
  );
});
