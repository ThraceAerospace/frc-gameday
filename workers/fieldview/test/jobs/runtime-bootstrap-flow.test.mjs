import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [readiness, polling, acquisition, eventRuntime, teamRuntime, dispatch] = await Promise.all([
  read("../../src/jobs/season-readiness.ts"),
  read("../../src/jobs/polling-coordinator.ts"),
  read("../../src/jobs/runtime-bootstrap-acquisition.ts"),
  read("../../src/runtime/event-runtime.ts"),
  read("../../src/runtime/team-runtime.ts"),
  read("../../src/runtime/runtime-dispatch.ts"),
]);

test("season readiness workflows acquire and hand off initial state for both entity kinds", () => {
  assert.match(readiness, /acquireRuntimeBootstrap/);
  assert.match(readiness, /dispatchRuntime\(env, kind, key, "bootstrap"/);
  assert.match(readiness, /bootstrapped: false, already_initialized: true, publication_status: "existing"/);
  assert.match(readiness, /!item\.bootstrapped && !item\.already_initialized/);
  assert.match(readiness, /already_initialized/);
  const workflow = readiness.slice(readiness.indexOf("async function runSeasonReadiness"), readiness.indexOf("export class EventSeasonReadinessWorkflow"));
  assert.doesNotMatch(workflow, /SEASON_REFRESH_QUEUE|sendBatch|consumeSeasonRefreshQueue/);
});

test("polling coordinator uses bootstrap only for missing initial states", () => {
  assert.match(polling, /acquireRuntimeBootstrap/);
  const eventInitial = polling.slice(polling.indexOf('step.do("acquire-missing-initial-event-states"'), polling.indexOf("const results: PollingEventResult[]"));
  const teamInitial = polling.slice(polling.indexOf('step.do("acquire-missing-initial-team-states"'), polling.indexOf("// Reconcile TeamRuntime results"));
  assert.match(eventInitial, /"bootstrap"/);
  assert.match(teamInitial, /"bootstrap"/);
  assert.doesNotMatch(eventInitial, /dispatchRuntimeRefresh/);
  assert.doesNotMatch(teamInitial, /dispatchRuntimeRefresh/);
  assert.match(polling, /dispatchRuntimeRefresh\(this\.env, \{\s*kind: "event"/);
});

test("workflow bootstrap acquisition covers all current EventRuntime and TeamRuntime providers", () => {
  assert.match(acquisition, /TBA_ENDPOINTS\.eventAdvancementPoints/);
  assert.match(acquisition, /STATBOTICS_ENDPOINTS\.matches/);
  assert.match(acquisition, /TBA_ENDPOINTS\.teamDistricts/);
  assert.match(acquisition, /STATBOTICS_ENDPOINTS\.teamYear/);
  assert.match(acquisition, /FRC_COLORS_ENDPOINTS\.team/);
  assert.match(acquisition, /for \(const resource of resources\)/);
});

test("both Durable Objects validate and persist bootstrap bundles before publishing", () => {
  for (const source of [eventRuntime, teamRuntime]) {
    assert.match(source, /validateRuntimeBootstrapBundle/);
    assert.match(source, /url\.pathname === "\/bootstrap"/);
    assert.match(source, /bootstrap:accepted:/);
    assert.match(source, /lastWebhookAt > body\.acquired_at/);
    assert.match(source, /await this\.(publishEventState|snapshot)\(/);
  }
  assert.match(dispatch, /bootstrap: "bootstrap"/);
  assert.match(dispatch, /action === "bootstrap" \? "bootstrap\?year="/);
});
