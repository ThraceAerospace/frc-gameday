import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../src/jobs/season-readiness.ts", import.meta.url), "utf8");
const eventStart = source.indexOf("export class EventSeasonReadinessWorkflow");
const teamStart = source.indexOf("export class TeamSeasonReadinessWorkflow");
const resolverStart = source.indexOf("export class SeasonStatusResolverWorkflow");

assert.ok(eventStart >= 0 && teamStart > eventStart && resolverStart > teamStart,
  "event readiness, team readiness, and season resolution must remain separate Workflow classes");

const eventWorkflow = source.slice(eventStart, teamStart);
const teamWorkflow = source.slice(teamStart, resolverStart);
const readinessRunner = source.slice(source.indexOf("async function runSeasonReadiness"), eventStart);

test("event and team readiness use distinct entity-scoped Workflow entrypoints", () => {
  assert.match(eventWorkflow, /runSeasonReadiness\(this\.env, event, step, "event"\)/);
  assert.match(teamWorkflow, /runSeasonReadiness\(this\.env, event, step, "team"\)/);
});

test("readiness inspects provider resources and bootstraps only missing entity data", () => {
  assert.match(readinessRunner, /dispatchRuntime\(env, kind, key, "readiness"/);
  assert.match(readinessRunner, /dispatchRuntime\(env, kind, key, "bootstrap"/);
  assert.match(readinessRunner, /already_initialized/);
  assert.match(readinessRunner, /resource_status/);
  assert.doesNotMatch(readinessRunner, /SEASON_REFRESH_QUEUE|sendBatch|consumeSeasonRefreshQueue/);
});

test("readiness executions persist indexed run records and chunked resource results", () => {
  assert.match(readinessRunner, /admin\/workflow-runs\/index/);
  assert.match(readinessRunner, /result_chunks/);
  assert.match(readinessRunner, /results\//);
  assert.match(readinessRunner, /summary\.json/);
  assert.match(readinessRunner, /completed_with_errors/);
});
