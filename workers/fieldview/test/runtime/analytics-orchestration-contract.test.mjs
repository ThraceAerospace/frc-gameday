import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION,
  isTeamEventAnalyticsCommand,
  isTeamEventAnalyticsResult,
} from "../../src/runtime/analytics-orchestration-contract.ts";

const command = {
  contract_version: EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION,
  event_key: "2026test",
  event_source_revision: 12,
  event_state: { event_key: "2026test" },
  comparison_input: { updated_at: 1700000000000, records: [] },
};

test("accepts a versioned TeamRuntime analytics command", () => {
  assert.equal(isTeamEventAnalyticsCommand(command), true);
});

test("rejects unsupported versions and mismatched event identities", () => {
  assert.equal(isTeamEventAnalyticsCommand({ ...command, contract_version: 2 }), false);
  assert.equal(isTeamEventAnalyticsCommand({ ...command, event_state: { event_key: "2025other" } }), false);
});

test("rejects invalid revisions and malformed comparison input", () => {
  assert.equal(isTeamEventAnalyticsCommand({ ...command, event_source_revision: -1 }), false);
  assert.equal(isTeamEventAnalyticsCommand({ ...command, comparison_input: { updated_at: 1 } }), false);
});

test("accepts a revision-stamped TeamRuntime result", () => {
  assert.equal(isTeamEventAnalyticsResult({
    contract_version: 1,
    event_key: "2026test",
    team_key: "frc3461",
    event_source_revision: 12,
    team_source_revision: 8,
    comparison_input_updated_at: 1700000000000,
    team_event_revision: 4,
    state: { event_key: "2026test", team_key: "frc3461" },
  }), true);
});

test("rejects TeamRuntime results with mismatched identity or incomplete revision stamps", () => {
  const result = {
    contract_version: 1,
    event_key: "2026test",
    team_key: "frc3461",
    event_source_revision: 12,
    team_source_revision: 8,
    comparison_input_updated_at: 1700000000000,
    team_event_revision: 4,
    state: { event_key: "2026test", team_key: "frc3461" },
  };
  assert.equal(isTeamEventAnalyticsResult({ ...result, state: { ...result.state, team_key: "frc2" } }), false);
  assert.equal(isTeamEventAnalyticsResult({ ...result, team_event_revision: null }), false);
});
