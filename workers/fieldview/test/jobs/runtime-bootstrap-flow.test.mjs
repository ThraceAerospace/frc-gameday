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
  assert.match(readiness, /bootstrapped: false, already_initialized: true, resource_status: "existing"/);
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

test("both Durable Objects bootstrap provider resources without materializing client state", () => {
  for (const source of [eventRuntime, teamRuntime]) {
    assert.match(source, /validateRuntimeBootstrapBundle/);
    assert.match(source, /url\.pathname === "\/bootstrap"/);
    assert.match(source, /bootstrap:accepted:/);
    assert.match(source, /lastWebhookAt > body\.acquired_at/);
    const bootstrapStart = source.indexOf('url.pathname === "/bootstrap"');
    const bootstrapEnd = source.indexOf("\n    if (", bootstrapStart + 1);
    const bootstrap = source.slice(bootstrapStart, bootstrapEnd);
    assert.doesNotMatch(bootstrap, /await this\.(publishEventState|snapshot)\(/);
    assert.match(bootstrap, /resource_status/);
  }
  assert.match(dispatch, /bootstrap: "bootstrap"/);
  assert.match(dispatch, /action === "bootstrap" \? "bootstrap\?year="/);
});


test("client state projections are optional and snapshot reads never persist them", () => {
  const eventProjectionStart = eventRuntime.indexOf("private async getEventStateProjection()");
  const eventProjectionEnd = eventRuntime.indexOf("private async recalculateAnalytics(", eventProjectionStart);
  const eventProjection = eventRuntime.slice(eventProjectionStart, eventProjectionEnd);
  assert.ok(eventProjectionStart >= 0 && eventProjectionEnd > eventProjectionStart);
  assert.doesNotMatch(eventProjection, /storage\.(put|delete)|transaction\(async/);
  const publicationStart = eventRuntime.indexOf("private async publishSnapshotRevision(");
  const publicationEnd = eventRuntime.indexOf("\n  }", publicationStart) + 4;
  const publication = eventRuntime.slice(publicationStart, publicationEnd);
  assert.ok(publicationStart >= 0 && publicationEnd > publicationStart);
  assert.match(publication, /change: "snapshot"/);
  assert.doesNotMatch(publication, /getEventStateProjection|EventStateProjection/,
    "provider updates publish revisions without constructing a client EventState");

  const teamProjectionStart = teamRuntime.indexOf("private async snapshot(year:");
  const teamProjectionEnd = teamRuntime.indexOf("private async pollResourceNow(", teamProjectionStart);
  const teamProjection = teamRuntime.slice(teamProjectionStart, teamProjectionEnd);
  assert.ok(teamProjectionStart >= 0 && teamProjectionEnd > teamProjectionStart);
  assert.doesNotMatch(teamProjection, /storage\.(put|delete)|tx\.(put|delete)/);

  const seasonAnalyticsStart = teamRuntime.indexOf("private async buildSeasonAnalyticsResponse(");
  const seasonAnalyticsEnd = teamRuntime.indexOf("\n  private async ", seasonAnalyticsStart + 1);
  const seasonAnalytics = teamRuntime.slice(seasonAnalyticsStart, seasonAnalyticsEnd);
  assert.doesNotMatch(seasonAnalytics, /storage\.put/);
  assert.match(seasonAnalytics, /seasonAnalyticsCache\.set/);
});
