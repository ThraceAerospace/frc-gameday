import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [jobs, weeklyWorkflow, projection, coordinator, entrypoint, wrangler, runtime, adminApi, adminPanel] = await Promise.all([
  read("../../src/jobs/index.ts"),
  read("../../src/jobs/weekly-event-projection.ts"),
  read("../../src/jobs/weekly-projection.ts"),
  read("../../src/jobs/polling-coordinator.ts"),
  read("../../src/index.ts"),
  read("../../wrangler.toml"),
  read("../../src/runtime/index.ts"),
  read("../../../../apps/web/src/app/api/admin/runtime/route.ts"),
  read("../../../../apps/web/src/app/admin/runtime/WorkflowRunsPanel.tsx"),
]);

test("daily event readiness no longer republishes the weekly candidate projection", () => {
  const start = jobs.indexOf("export class DailyEventReadinessWorkflow");
  const end = jobs.indexOf("export class DailyTeamReadinessWorkflow");
  assert.ok(start >= 0 && end > start);
  const eventReadiness = jobs.slice(start, end);
  assert.doesNotMatch(eventReadiness, /events-this-week|projections\/events\/this-week|classifyEventThisWeek/);
});

test("the weekly workflow refreshes Discovery and publishes one current projection", () => {
  assert.match(weeklyWorkflow, /catalog\("discover-event-directory"/);
  assert.match(weeklyWorkflow, /write-event-chunks/);
  assert.match(weeklyWorkflow, /publish-event-directory/);
  assert.match(weeklyWorkflow, /projections\/events-this-week\/current\.json/);
  assert.match(weeklyWorkflow, /buildEventsThisWeekProjection/);
  assert.match(projection, /classifyEventThisWeek\(event, evaluatedAt\)/);
  assert.match(projection, /utcWeekWindow/);
});

test("the polling coordinator consumes the current week's projection and evaluates lifecycle at dispatch time", () => {
  assert.match(coordinator, /projections\/events-this-week\/current\.json/);
  assert.match(coordinator, /utcProjectionWeekWindow\(scheduledAt\)/);
  assert.match(coordinator, /selectActiveEvents\(projectionEvents, scheduledAt\)/);
  assert.doesNotMatch(coordinator, /projections\/events\/this-week/);
});

test("Monday scheduling and the admin refresh control target the same Workflow", () => {
  assert.match(entrypoint, /controller\.cron === "0 16 \* \* 1"/);
  assert.match(entrypoint, /WEEKLY_EVENT_PROJECTION\.create/);
  assert.match(wrangler, /crons = .*"0 16 \* \* 1"/);
  assert.match(wrangler, /binding = "WEEKLY_EVENT_PROJECTION"/);
  assert.match(jobs, /\/internal\/admin\/events-this-week\/refresh/);
  assert.match(jobs, /workflow\.create\(\{ id, params: \{ requestedAt, reason: "manual" \} \}\)/);
  assert.match(runtime, /\/internal\/admin\/events-this-week\/refresh/);
  assert.match(adminApi, /workflowType === "events-this-week"/);
  assert.match(adminPanel, /Rebuild weekly event candidates/);
  assert.match(adminPanel, /weeklyProjectionRun/);
});

test("the public weekly event route reads only the canonical projection", () => {
  assert.match(runtime, /projections\/events-this-week\/current\.json/);
  assert.doesNotMatch(runtime, /projections\/events\/this-week/);
});
