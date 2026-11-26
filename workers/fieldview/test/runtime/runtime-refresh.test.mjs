import test from "node:test";
import assert from "node:assert/strict";
import { dispatchRuntimeRefreshBatch } from "../../src/runtime/runtime-refresh.ts";

function namespace(handler) {
  return {
    idFromName(name) { return name; },
    get(id) { return { fetch: (request) => handler(request, id) }; },
  };
}

test("team refresh batch coalesces affected events into one durable analytics Workflow", async () => {
  const workflows = [];
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    TEAM_RUNTIME: namespace(async () => Response.json({
      team_state_revision: 8,
      affected_events: [{ event_key: "2027rikin", team_event_revision: 3 }],
    })),
    EVENT_ANALYTICS_WORKFLOW: {
      get: async () => { throw new Error("Workflow instance does not exist"); },
      create: async (input) => { workflows.push(input); return {}; },
    },
  };

  const outcomes = await dispatchRuntimeRefreshBatch(env, [
    { kind: "team", key: "frc3461", year: 2027 },
    { kind: "team", key: "frc2", year: 2027 },
  ], 2);

  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every((outcome) => outcome.ok));
  assert.equal(workflows.length, 1,
    "a batch with multiple changed teams in one event must start one event Workflow");
  assert.match(workflows[0].id, /^team-event-analytics-2027rikin-/);
  assert.deepEqual(workflows[0].params, {
    event_key: "2027rikin",
    affected_team_keys: ["frc2", "frc3461"],
    requested_at: workflows[0].params.requested_at,
  });
  assert.ok(Number.isSafeInteger(workflows[0].params.requested_at));
});

test("single team refresh starts a Workflow for every affected event", async () => {
  const workflows = [];
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    TEAM_RUNTIME: namespace(async () => Response.json({
      team_state_revision: 9,
      affected_events: [
        { event_key: "2027rikin", team_event_revision: 4 },
        { event_key: "2027other", team_event_revision: 2 },
      ],
    })),
    EVENT_ANALYTICS_WORKFLOW: {
      get: async () => { throw new Error("Workflow instance does not exist"); },
      create: async (input) => { workflows.push(input); return {}; },
    },
  };

  const { dispatchRuntimeRefresh } = await import("../../src/runtime/runtime-refresh.ts");
  const outcome = await dispatchRuntimeRefresh(env, { kind: "team", key: "frc3461", year: 2027 });

  assert.equal(outcome.ok, true);
  assert.deepEqual(workflows.map((item) => item.params.event_key).sort(), ["2027other", "2027rikin"]);
  assert.ok(workflows.every((item) => item.params.affected_team_keys.length === 1 &&
    item.params.affected_team_keys[0] === "frc3461"));
});


test("poll-cycle event and team refreshes coalesce into one Workflow with the union of affected teams", async () => {
  const workflows = [];
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    TEAM_RUNTIME: namespace(async (_request, teamKey) => Response.json({
      team_state_revision: 12,
      affected_events: [{ event_key: "2027rikin", team_event_revision: teamKey === "frc3461" ? 5 : 2 }],
    })),
    EVENT_ANALYTICS_WORKFLOW: {
      get: async () => { throw new Error("Workflow instance does not exist"); },
      create: async (input) => { workflows.push(input); return {}; },
    },
  };

  await dispatchRuntimeRefreshBatch(env, [
    { kind: "team", key: "frc3461", year: 2027 },
    { kind: "team", key: "frc2", year: 2027 },
  ], 2, {
    requestedAt: 1_800_000_000_000,
    additionalAffectedEvents: new Map([
      ["2027rikin", { affected_team_keys: ["frc3", "frc3461"] }],
    ]),
  });

  assert.equal(workflows.length, 1);
  assert.deepEqual(workflows[0].params, {
    event_key: "2027rikin",
    affected_team_keys: ["frc2", "frc3", "frc3461"],
    requested_at: 1_800_000_000_000,
  });
});

test("an unsafe event match comparison forces full recompute when coalesced with team refreshes", async () => {
  const workflows = [];
  const env = {
    RUNTIME_ADMIN_TOKEN: "test-token",
    TEAM_RUNTIME: namespace(async () => Response.json({
      team_state_revision: 12,
      affected_events: [{ event_key: "2027rikin", team_event_revision: 5 }],
    })),
    EVENT_ANALYTICS_WORKFLOW: {
      get: async () => { throw new Error("Workflow instance does not exist"); },
      create: async (input) => { workflows.push(input); return {}; },
    },
  };

  await dispatchRuntimeRefreshBatch(env, [
    { kind: "team", key: "frc3461", year: 2027 },
  ], 2, {
    requestedAt: 1_800_000_000_000,
    additionalAffectedEvents: new Map([
      ["2027rikin", { affected_team_keys: null }],
    ]),
  });

  assert.equal(workflows.length, 1);
  assert.equal(workflows[0].params.affected_team_keys, null,
    "an unsafe event comparison must not be narrowed by the team refresh's known changed team");
});


test("event-only poll refresh dispatches analytics after the collection phase", async () => {
  const workflows = [];
  const env = {
    EVENT_ANALYTICS_WORKFLOW: {
      get: async () => { throw new Error("Workflow instance does not exist"); },
      create: async (input) => { workflows.push(input); return {}; },
    },
  };

  await dispatchRuntimeRefreshBatch(env, [], 4, {
    requestedAt: 1_800_000_000_000,
    additionalAffectedEvents: new Map([
      ["2027rikin", { affected_team_keys: ["frc3461", "frc2"] }],
    ]),
  });

  assert.equal(workflows.length, 1);
  assert.deepEqual(workflows[0].params, {
    event_key: "2027rikin",
    affected_team_keys: ["frc2", "frc3461"],
    requested_at: 1_800_000_000_000,
  });
});
