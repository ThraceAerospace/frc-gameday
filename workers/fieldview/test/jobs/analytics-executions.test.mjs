import assert from "node:assert/strict";
import test from "node:test";
import { AnalyticsExecutionRepository } from "../../src/jobs/analytics-executions.ts";

function createStorage() {
  const records = new Map();
  return {
    records,
    async get(key) { return records.get(key); },
    async put(key, value) { records.set(key, value); },
    async delete(key) { return records.delete(key); },
    async list({ prefix = "", limit = 1000 } = {}) {
      return new Map([...records.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit));
    },
  };
}

function input(overrides = {}) {
  return {
    executionId: "2026cthar-1700000000000",
    eventKey: "2026cthar",
    retryKey: "1700000000000",
    workflowId: "event-analytics-2026cthar-1700000000000",
    affectedTeamKeys: null,
    requestedAt: 1700000000000,
    attempt: 0,
    now: 1700000001000,
    ...overrides,
  };
}

test("analytics execution repository persists a typed running record in the System Records key family", async () => {
  const storage = createStorage();
  const repository = new AnalyticsExecutionRepository(storage);
  const record = await repository.start(input());
  assert.equal(record.status, "running");
  assert.equal(record.workflow_id, "event-analytics-2026cthar-1700000000000");
  assert.equal(record.started_at, 1700000001000);
  assert.deepEqual([...storage.records.keys()], [
    "system/analytics-executions/2026cthar-1700000000000.json",
  ]);
});

test("analytics execution retries retain a stable logical identity and update the active attempt", async () => {
  const storage = createStorage();
  const repository = new AnalyticsExecutionRepository(storage);
  await repository.start(input());
  await repository.fail("2026cthar-1700000000000", new Error("provider unavailable"), undefined, 1700000002000);
  const failed = await repository.get("2026cthar-1700000000000");
  assert.equal(failed.status, "failed");
  assert.equal(failed.next_retry_at, 1700000302000);
  assert.equal(failed.error_class, "Error");

  await repository.retryScheduled(
    "2026cthar-1700000000000",
    "event-analytics-2026cthar-1700000000000-retry-1",
    "event-analytics-2026cthar-1700000000000",
    1700000302000,
  );
  const scheduled = await repository.get("2026cthar-1700000000000");
  assert.equal(scheduled.status, "retry_scheduled");
  assert.equal(scheduled.retry_workflow_id, "event-analytics-2026cthar-1700000000000-retry-1");

  await repository.start(input({
    workflowId: "event-analytics-2026cthar-1700000000000-retry-1",
    attempt: 1,
    now: 1700000303000,
  }));
  const retry = await repository.get("2026cthar-1700000000000");
  assert.equal(retry.attempt, 1);
  assert.equal(retry.started_at, 1700000001000);
  assert.equal(retry.workflow_id, "event-analytics-2026cthar-1700000000000-retry-1");
});

test("stale Workflow attempts cannot overwrite the current attempt or terminal result", async () => {
  const repository = new AnalyticsExecutionRepository(createStorage());
  await repository.start(input());
  await repository.start(input({
    workflowId: "retry-1",
    attempt: 1,
    now: 1700000300000,
  }));
  await repository.fail("2026cthar-1700000000000", new Error("late parent failure"),
    "event-analytics-2026cthar-1700000000000", 1700000301000);
  let record = await repository.get("2026cthar-1700000000000");
  assert.equal(record.workflow_id, "retry-1");
  assert.equal(record.status, "running");

  await repository.complete("2026cthar-1700000000000", {
    registered_team_count: 40,
    recalculated_team_count: 38,
  }, 12, "retry-1", 1700000302000);
  await repository.fail("2026cthar-1700000000000", new Error("late failure"), "retry-1", 1700000303000);
  record = await repository.get("2026cthar-1700000000000");
  assert.equal(record.status, "completed");
  assert.equal(record.source_revision, 12);
  assert.deepEqual(record.outcome, { registered_team_count: 40, recalculated_team_count: 38 });
});

test("final failed attempts are terminal and execution listing is bounded", async () => {
  const storage = createStorage();
  const repository = new AnalyticsExecutionRepository(storage);
  await repository.start(input({ executionId: "a", eventKey: "2026a", retryKey: "a", attempt: 2 }));
  await repository.fail("a", new Error("terminal"), undefined, 1700000002000);
  const terminal = await repository.get("a");
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.completed_at, 1700000002000);
  assert.equal(terminal.next_retry_at, undefined);

  await repository.start(input({ executionId: "b", eventKey: "2026b", retryKey: "b", now: 1700000003000 }));
  assert.equal((await repository.list(1)).length, 1);
});
