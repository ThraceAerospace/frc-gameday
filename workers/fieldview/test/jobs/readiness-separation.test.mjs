import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../src/jobs/index.ts", import.meta.url), "utf8");
const eventStart = source.indexOf("export class DailyEventReadinessWorkflow");
const teamStart = source.indexOf("export class DailyTeamReadinessWorkflow");
const auditStart = source.indexOf("export class CoverageAuditWorkflow");

assert.ok(eventStart >= 0 && teamStart > eventStart && auditStart > teamStart,
  "event readiness, team readiness, and coverage audit must remain separate Workflow classes");

const eventWorkflow = source.slice(eventStart, teamStart);
const teamWorkflow = source.slice(teamStart, auditStart);

test("event readiness owns only Event Discovery and EventRuntime readiness", () => {
  assert.match(eventWorkflow, /dispatchRuntime\(this\.env, "event",/);
  assert.doesNotMatch(eventWorkflow, /dispatchRuntime\(this\.env, "team",/);
  assert.doesNotMatch(eventWorkflow, /discover-team-page|publish-team-directory|TEAM_RUNTIME/);
  assert.match(eventWorkflow, /workflows\/daily-event-readiness\//);
});

test("team readiness owns only Team Discovery and TeamRuntime readiness", () => {
  assert.match(teamWorkflow, /dispatchRuntime\(this\.env, "team",/);
  assert.doesNotMatch(teamWorkflow, /dispatchRuntime\(this\.env, "event",/);
  assert.doesNotMatch(teamWorkflow, /discover-event-directory|publish-event-directory|DAILY_EVENT_READINESS/);
  assert.match(teamWorkflow, /resolve-current-season/);
  assert.match(teamWorkflow, /workflows\/daily-team-readiness\//);
});

test("readiness inspects only registered runtimes and never dispatches provider refreshes", () => {
  assert.match(eventWorkflow, /listRuntimeRegistry\(store\(\), "event"\)/);
  assert.match(teamWorkflow, /listRuntimeRegistry\(store\(\), "team"\)/);
  assert.match(eventWorkflow, /registeredEventKeys\.has\(item\.key\)/);
  assert.match(teamWorkflow, /registeredTeamKeys\.has\(teamKey\)/);
  assert.doesNotMatch(eventWorkflow, /refreshNow/);
  assert.doesNotMatch(teamWorkflow, /refreshNow/);
  assert.match(source, /refresh_dispatched: false/);
});

test("readiness executions persist indexed run records, final summaries, and chunked entity results", () => {
  for (const [workflow, type] of [[eventWorkflow, "event-readiness"], [teamWorkflow, "team-readiness"]]) {
    assert.match(workflow, new RegExp(`admin/workflow-runs/index/${type}`));
    assert.match(workflow, /result_chunks/);
    assert.match(workflow, /results\//);
    assert.match(workflow, /summary\.json/);
    assert.match(workflow, /completed_with_errors/);
  }
});

test("workflow run history is admin-authenticated and supports list and ID lookup", () => {
  assert.match(source, /\/internal\/admin\/workflow-runs/);
  assert.match(source, /workflowBinding\.get\(workflowId\)/);
  assert.match(source, /workflow_id/);
});
