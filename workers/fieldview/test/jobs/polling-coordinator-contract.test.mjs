import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [entrypoint, coordinator, eventRuntime, teamRuntime] = await Promise.all([
  read("../../src/index.ts"),
  read("../../src/jobs/polling-coordinator.ts"),
  read("../../src/runtime/event-runtime.ts"),
  read("../../src/runtime/team-runtime.ts"),
]);

test("the scheduled Worker entrypoint starts the polling coordinator Workflow", () => {
  assert.match(entrypoint, /scheduled\s*\(/);
  assert.match(entrypoint, /env\.POLLING_COORDINATOR\.create\(/);
  assert.match(entrypoint, /params:\s*\{\s*scheduledAt,\s*pollTeams:/);
  assert.match(entrypoint, /context\.waitUntil\(/);
  assert.doesNotMatch(entrypoint, /setAlarm\s*\(|deleteAlarm\s*\(/);
});

test("the coordinator reads published discovery and never acquires provider data directly", () => {
  assert.match(coordinator, /discovery\/current-season\.json/);
  assert.match(coordinator, /projections\/events-this-week\/current\.json/);
  assert.match(coordinator, /selectActiveEvents\(/);
  assert.match(coordinator, /isRuntimeRegistered\(/);
  assert.match(coordinator, /dispatchRuntime\(/);
  assert.match(coordinator, /dispatchRuntimeRefresh\(/);
  assert.doesNotMatch(coordinator, /this\.env\.TBA_API_KEY/);
  assert.doesNotMatch(coordinator, /fetch\s*\(/);
});

test("event provider refresh is dispatched only after readiness says it is due", () => {
  const readinessIndex = coordinator.indexOf('"readiness"');
  const refreshIndex = coordinator.indexOf("dispatchRuntimeRefresh(this.env");
  assert.ok(readinessIndex >= 0 && refreshIndex > readinessIndex);
  assert.match(coordinator, /readinessBody\.refresh_required\s*===\s*true/);
  assert.match(coordinator, /staleEndpoints\.length\s*\?/);
});

test("daily team work is separately gated and bounded", () => {
  assert.match(coordinator, /if\s*\(pollTeams\s*&&\s*participantTeamKeys\.size\s*>\s*0\)/);
  assert.match(coordinator, /MAX_TEAM_READINESS_CHECKS_PER_RUN/);
  assert.match(coordinator, /MAX_TEAM_REFRESH_COMMANDS_PER_RUN/);
  assert.match(coordinator, /dispatchRuntimeRefreshBatch\(this\.env,\s*boundedDueTeams,\s*4,\s*\{/);
  assert.match(coordinator, /mapLimit\([^\n]*,\s*4,/);
});

test("Durable Object runtimes contain no alarm handlers or alarm scheduling APIs", () => {
  for (const [name, source] of [["EventRuntime", eventRuntime], ["TeamRuntime", teamRuntime]]) {
    assert.doesNotMatch(source, /\balarm\s*\(/, name + " must not define an alarm handler");
    assert.doesNotMatch(source, /\bsetAlarm\s*\(/, name + " must not schedule an alarm");
    assert.doesNotMatch(source, /\bdeleteAlarm\s*\(/, name + " must not delete an alarm");
  }
});


test("event and daily team refresh analytics triggers are coalesced after both refresh phases", () => {
  const collectIndex = coordinator.indexOf("eventAnalyticsRequests.set(");
  const teamBatchIndex = coordinator.indexOf("dispatchRuntimeRefreshBatch(this.env, boundedDueTeams, 4");
  const deferredDispatchIndex = coordinator.indexOf("start-event-analytics-for-refreshed-events");
  assert.ok(collectIndex >= 0, "event refreshes must collect affected-team information");
  assert.ok(teamBatchIndex > collectIndex, "team refreshes must join the event refresh collection");
  assert.ok(deferredDispatchIndex > teamBatchIndex,
    "event-only dispatch is deferred until the team refresh phase is known");
  assert.match(coordinator, /additionalAffectedEvents:\s*eventAnalyticsRequests/);
  const eventLoopStart = coordinator.indexOf("for (const candidate of candidates)");
  const teamRecoveryStart = coordinator.indexOf("// Reconcile TeamRuntime results that were calculated");
  const eventLoop = coordinator.slice(eventLoopStart, teamRecoveryStart);
  assert.equal(eventLoop.includes("EVENT_ANALYTICS_WORKFLOW.create("), false,
    "the polling coordinator must not independently create an event workflow inside its event loop");
});

test("the coordinator scans registered teams for pending analytics and coalesces recovery dispatch", () => {
  assert.match(coordinator, /registry\/teams\//);
  assert.match(coordinator, /MAX_PENDING_ANALYTICS_RECOVERY_CHECKS_PER_RUN/);
  assert.match(coordinator, /MAX_PENDING_ANALYTICS_RECOVERY_EVENTS_PER_RUN/);
  assert.match(coordinator, /pending_analytics_recovery_events_deferred_by_budget/);
  assert.match(coordinator, /"pending-analytics"/);
  assert.match(coordinator, /pendingAnalyticsRecoveryChecksFailed/);
  assert.match(coordinator, /revision_parts:/);
  assert.match(coordinator, /recovery:\s*true/);
  assert.match(coordinator, /additionalAffectedEvents:\s*eventAnalyticsRequests/);
  assert.match(teamRuntime, /pending-event-analytics/);
  assert.match(teamRuntime, /publication_status\s*!==\s*"pending"/);
});


test("analytics Workflow execution is recorded before the first runtime input or TeamRuntime write", async () => {
  const workflow = await read("../../src/jobs/event-analytics.ts");
  assert.match(workflow, /AnalyticsExecutionRepository\.fromEnvironment\(this\.env\)/);
  assert.ok(workflow.indexOf("await repository.start(") < workflow.indexOf("private async runExecution("));
  assert.match(workflow, /await repository\.complete\(/);
  assert.match(workflow, /await repository\.fail\(/);
  assert.match(workflow, /await repository\.retryScheduled\(/);
  assert.match(workflow, /private async runExecution\(/);
});

test("polling coordinator reconciles and retries analytics Workflow executions with bounded deterministic IDs", () => {
  assert.match(coordinator, /recoverAnalyticsExecutions\(this\.env, scheduledAt\)/);
  assert.match(coordinator, /MAX_ANALYTICS_EXECUTION_RECOVERIES_PER_RUN = 5/);
  assert.match(coordinator, /STALE_ANALYTICS_WORKFLOW_MS = 15 \* 60_000/);
  assert.match(coordinator, /"-retry-"/);
  assert.match(coordinator, /status === "errored" \|\| status === "terminated"/);
  assert.match(coordinator, /record\.attempt < 2/);
  assert.match(coordinator, /analytics_execution_recovery_dispatched/);
});
