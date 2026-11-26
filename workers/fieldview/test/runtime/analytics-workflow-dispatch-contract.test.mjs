import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../src/runtime/index.ts", import.meta.url), "utf8");

test("analytics execution record is written before Cloudflare Workflow creation", () => {
  const helperStart = source.indexOf("async function createEventAnalyticsWorkflow(");
  const helperEnd = source.indexOf("\n}\n", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /AnalyticsExecutionRepository\.fromEnvironment\(env\)/);
  assert.ok(helper.indexOf("await repository.start(") < helper.indexOf("await workflow.create("));
  assert.match(helper, /await repository\.fail\(executionId, error, input\.workflowId\)/);
  assert.match(helper, /retry_key: input\.retryKey/);
});

test("TBA webhook and manual refresh analytics dispatch share the durable pre-create helper", () => {
  assert.match(source, /createEventAnalyticsWorkflow\(env,\s*\{\s*workflowId, eventKey, affectedTeamKeys/);
  assert.match(source, /createEventAnalyticsWorkflow\(env,\s*\{\s*workflowId: analyticsWorkflowId/);
  assert.doesNotMatch(source, /EVENT_ANALYTICS_WORKFLOW\.create\(/);
});
