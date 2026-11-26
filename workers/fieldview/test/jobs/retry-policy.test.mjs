import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isRetryableWorkflowHttpStatus } from "../../src/jobs/retry-policy.ts";

test("Workflow HTTP retry policy includes throttling, transient gateway, and server failures", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableWorkflowHttpStatus(status), true, String(status));
  }
});

test("Workflow HTTP retry policy does not retry permanent client errors or success", () => {
  for (const status of [200, 204, 400, 401, 403, 404, 409, 422]) {
    assert.equal(isRetryableWorkflowHttpStatus(status), false, String(status));
  }
});

test("event analytics retries failed season inputs rather than silently publishing around transient failures", async () => {
  const source = await readFile(new URL("../../src/jobs/event-analytics.ts", import.meta.url), "utf8");
  assert.match(source, /failedSeasonInput/);
  assert.match(source, /isRetryableWorkflowHttpStatus\(failedSeasonInput\.status\)/);
  assert.match(source, /scheduleRetry\("team-season-input-failure", null\)/);
  assert.match(source, /isRetryableWorkflowHttpStatus\(failedTeam\.status\)/);
  assert.match(source, /item\.status !== 200 && item\.status !== 404/);
});

test("recovery retry identity is stable and is propagated to bounded child Workflows", async () => {
  const [workflow, refresh] = await Promise.all([
    readFile(new URL("../../src/jobs/event-analytics.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/runtime/runtime-refresh.ts", import.meta.url), "utf8"),
  ]);
  assert.match(workflow, /retry_key:\s*retryKey/);
  assert.match(workflow, /"event-analytics-" \+ eventKey \+ "-" \+ retryKey \+ "-retry-"/);
  assert.match(refresh, /retry_key:\s*workflowId === baseId \? baseRetryKey : recoveryRetryKey/);
  assert.match(refresh, /hash \+ "-" \+ window \+ "-base"/);
  assert.match(refresh, /hash \+ "-" \+ window \+ "-recovery"/);
});
