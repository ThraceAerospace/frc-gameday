import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
  }));
  return groups.flat();
}

test("consolidated Worker source does not import retired sibling projects", async () => {
  const files = await listTypeScriptFiles(sourceRoot);
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (source.includes("fieldview-runtime/src/") || source.includes("fieldview-jobs/src/")) {
      offenders.push(path.relative(sourceRoot, file));
    }
  }
  assert.deepEqual(offenders, []);
});


test("event analytics acknowledges team results only after EventRuntime publication", async () => {
  const source = await readFile(path.join(sourceRoot, "jobs", "event-analytics.ts"), "utf8");
  const publication = source.indexOf('step.do("publish-event-analytics-aggregate"');
  const publicationCheck = source.indexOf("if (!publicationResult.ok)", publication);
  const acknowledgement = source.indexOf('step.do("acknowledge-published-team-analytics"', publicationCheck);
  assert.ok(publication >= 0, "the Workflow must publish the EventRuntime aggregate");
  assert.ok(publicationCheck > publication, "the Workflow must check the aggregate publication result");
  assert.ok(acknowledgement > publicationCheck,
    "the Workflow must acknowledge TeamRuntime results only after successful EventRuntime publication");
  assert.ok(source.includes('scheduleRetry("team-publication-acknowledgement-failure", null)'),
    "failed acknowledgements must be retried through a new durable Workflow");
  assert.ok(source.includes('scheduleRetry("team-publication-acknowledgement-conflict", null)'),
    "stale acknowledgements must trigger a full revision-consistent recompute");
});

test("season readiness registers missing event and team Durable Objects before inspection and bootstrap", async () => {
  const readiness = await readFile(path.join(sourceRoot, "jobs", "season-readiness.ts"), "utf8");
  const eventRuntime = await readFile(path.join(sourceRoot, "runtime", "event-runtime.ts"), "utf8");
  const teamRuntime = await readFile(path.join(sourceRoot, "runtime", "team-runtime.ts"), "utf8");
  assert.match(readiness, /async function ensureRegistered\\(/);
  assert.ok(readiness.includes("registry/runtime-events/"));
  assert.ok(readiness.includes("registry/runtime-teams/"));
  assert.match(readiness, /namespace\\.get\\(namespace\\.idFromName\\(key\\)\\)/);
  assert.match(readiness, /"-runtime\\/register"/);
  assert.match(eventRuntime, /url\\.pathname === "\\/register"/);
  assert.match(teamRuntime, /url\\.pathname === "\\/register"/);
  const runner = readiness.slice(readiness.indexOf("async function runSeasonReadiness"), readiness.indexOf("export class EventSeasonReadinessWorkflow"));
  const registration = runner.indexOf("await ensureRegistered(env, kind, keys, year, step)");
  const inspection = runner.indexOf('dispatchRuntime(env, kind, key, "readiness"');
  assert.ok(registration >= 0 && inspection > registration,
    "all identities must be registered before readiness inspection begins");
  const registrationHelper = readiness.slice(readiness.indexOf("async function ensureRegistered"), readiness.indexOf("async function runSeasonReadiness"));
  assert.doesNotMatch(registrationHelper, /setAlarm|deleteAlarm|refresh\\(/);
});
