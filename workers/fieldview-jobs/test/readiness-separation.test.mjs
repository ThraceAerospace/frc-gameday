import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
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
