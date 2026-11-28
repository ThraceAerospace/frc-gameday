import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [discovery, readiness, acquisition] = await Promise.all([
  readFile(new URL("../../src/jobs/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../../src/jobs/season-readiness.ts", import.meta.url), "utf8"),
  readFile(new URL("../../src/jobs/runtime-bootstrap-acquisition.ts", import.meta.url), "utf8"),
]);

test("season discovery dispatches baseline EventRuntime seeding after registering every event", () => {
  const registrationStart = discovery.indexOf('if (payload.operation === "register-event-batch")');
  const registrationEnd = discovery.indexOf('if (payload.operation === "discover-team-directory")', registrationStart);
  assert.ok(registrationStart >= 0 && registrationEnd > registrationStart);
  const registration = discovery.slice(registrationStart, registrationEnd);
  const register = registration.indexOf('namespace.get(namespace.idFromName(key))');
  const seed = registration.indexOf('step.do("dispatch-event-baseline-seed"');
  const teamDiscovery = registration.indexOf('child(jobId + "-team-directory", "discover-team-directory")');
  assert.ok(register >= 0 && seed > register,
    "the baseline seed must not race event Durable Object registration");
  assert.ok(teamDiscovery > seed,
    "the seed must be dispatched as part of the initial season-discovery path");
  assert.match(registration, /EVENT_SEASON_READINESS\.create/);
  assert.match(registration, /params: \{ year: season, requestedAt \}/);
  assert.match(registration, /event_baseline_seed_workflow_id/);
});

test("baseline event seeding acquires only TBA Event and event-team roster resources", () => {
  const eventReadiness = readiness.slice(
    readiness.indexOf('export class EventSeasonReadinessWorkflow'),
    readiness.indexOf('export class TeamSeasonReadinessWorkflow'),
  );
  assert.match(eventReadiness, /runSeasonReadiness\(this\.env, event, step, "event"\)/);
  const eventResources = acquisition.slice(
    acquisition.indexOf("function eventResources"),
    acquisition.indexOf("function teamResources"),
  );
  assert.match(eventResources, /TBA_ENDPOINTS\.event\(eventKey\)/);
  assert.match(eventResources, /TBA_ENDPOINTS\.eventTeams\(eventKey\)/);
  assert.doesNotMatch(eventResources, /STATBOTICS|eventMatches|eventRankings/);
});

test("the season baseline seed is not gated by weekly projection membership", () => {
  const registrationStart = discovery.indexOf('if (payload.operation === "register-event-batch")');
  const registrationEnd = discovery.indexOf('if (payload.operation === "discover-team-directory")', registrationStart);
  const registration = discovery.slice(registrationStart, registrationEnd);
  assert.doesNotMatch(registration, /WEEKLY_EVENT_PROJECTION|events-this-week|weekStart|weekEnd/);
  assert.match(registration, /EVENT_SEASON_READINESS\.create/);
});


test("event baseline seeding uses serial bounded child workflows", () => {
  assert.match(readiness, /eventKeys\?: string\[\]/);
  assert.match(readiness, /const chunkSize = 20/);
  assert.match(readiness, /eventKeys: chunk/);
  assert.match(readiness, /EVENT_SEASON_READINESS\.create/);
  assert.match(readiness, /wait-event-baseline-child-/);
  assert.match(readiness, /step\.sleep\([^\n]+, "10 seconds"\)/);
  assert.match(readiness, /childStatus === "complete"/);
});
