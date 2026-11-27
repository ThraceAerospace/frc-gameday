import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../src/jobs/season-readiness.ts", import.meta.url), "utf8");

test("season refresh tasks retain their originating readiness Workflow identity", () => {
  assert.match(source, /type RefreshTask = \{[^}]*workflow_id: string; workflow_type: string/);
  assert.match(source, /workflow_id: workflowId, workflow_type: type/);
  assert.match(source, /workflow_ids: workflowIds/);
  assert.match(source, /workflow_type: item\.task\.workflow_type/);
});

test("queue logs identify each entity-season task and its dispatch outcome", () => {
  assert.match(source, /const taskId = task\.kind \+ ":" \+ task\.year \+ ":" \+ task\.key/);
  assert.match(source, /\[season-refresh-task\]/);
  assert.match(source, /task_id: item\.task_id/);
  assert.match(source, /kind: item\.task\.kind/);
  assert.match(source, /key: item\.task\.key/);
  assert.match(source, /year: item\.task\.year/);
  assert.match(source, /outcome: item\.outcome/);
});

test("queue invocation detects duplicate entity-season tasks without persistent writes", () => {
  assert.match(source, /const seenTaskIds = new Set<string>\(\)/);
  assert.match(source, /const duplicate = seenTaskIds\.has\(taskId\)/);
  assert.match(source, /duplicate_tasks: duplicateTaskIds\.size/);
  assert.match(source, /unique_task_ids_in_message/);
  const consumer = source.slice(source.indexOf("export async function consumeSeasonRefreshQueue"));
  assert.doesNotMatch(consumer, /\.put\(|\.delete\(|\.send\(/);
});

test("queue summaries distinguish dispatched, skipped, invalid, and retry outcomes", () => {
  assert.match(source, /dispatched: count\("dispatched"\)/);
  assert.match(source, /skipped: count\("skipped"\)/);
  assert.match(source, /invalid: count\("invalid"\)/);
  assert.match(source, /retry: count\("retry"\)/);
});

test("season readiness no longer produces queue messages for initial resource acquisition", () => {
  const runner = source.slice(source.indexOf("async function runSeasonReadiness"), source.indexOf("export class EventSeasonReadinessWorkflow"));
  assert.match(runner, /acquireRuntimeBootstrap/);
  assert.match(runner, /dispatchRuntime\(env, kind, key, "bootstrap"/);
  assert.doesNotMatch(runner, /packSeasonRefreshQueueBatches|sendBatch|SEASON_REFRESH_QUEUE/);
});
