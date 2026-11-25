import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_ANALYTICS_ORCHESTRATION_CONTRACT_VERSION,
  isEventAnalyticsTeamInput,
  isEventAnalyticsPublicationCommand,
  isTeamAnalyticsSeasonInput,
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

test("accepts revisioned EventRuntime and TeamRuntime input envelopes", () => {
  assert.equal(isEventAnalyticsTeamInput({
    contract_version: 1,
    event_key: "2026test",
    event_source_revision: 9,
    comparison_input_updated_at: null,
    event_state: { event_key: "2026test" },
  }), true);
  assert.equal(isTeamAnalyticsSeasonInput({
    contract_version: 1,
    team_key: "frc3461",
    team_source_revision: 4,
    team_state: { team_key: "frc3461" },
  }), true);
});

test("rejects input envelopes with mismatched identities or invalid revisions", () => {
  assert.equal(isEventAnalyticsTeamInput({
    contract_version: 1, event_key: "2026test", event_source_revision: -1,
    comparison_input_updated_at: null,
    event_state: { event_key: "2026test" },
  }), false);
  assert.equal(isEventAnalyticsTeamInput({
    contract_version: 1, event_key: "2026test", event_source_revision: 1,
    comparison_input_updated_at: null,
    event_state: { event_key: "2025other" },
  }), false);
  assert.equal(isTeamAnalyticsSeasonInput({
    contract_version: 1, team_key: "frc3461", team_source_revision: 1,
    team_state: { team_key: "frc2" },
  }), false);
});


test("accepts an event publication command containing coherent team results", () => {
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
  assert.equal(isEventAnalyticsPublicationCommand({
    contract_version: 1,
    event_key: "2026test",
    event_source_revision: 12,
    recalculated_team_keys: ["frc3461"],
    team_results: [result],
  }), true);
});

test("rejects event publication results built from different comparison inputs", () => {
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
  assert.equal(isEventAnalyticsPublicationCommand({
    contract_version: 1,
    event_key: "2026test",
    event_source_revision: 12,
    recalculated_team_keys: ["frc3461"],
    team_results: [result, { ...result, team_key: "frc2", state: { ...result.state, team_key: "frc2" }, comparison_input_updated_at: 1700000000001 }],
  }), false);
});

test("rejects mixed-revision, mismatched, and duplicate team results", () => {
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
  const publication = {
    contract_version: 1,
    event_key: "2026test",
    event_source_revision: 12,
    recalculated_team_keys: ["frc3461"],
    team_results: [result],
  };
  assert.equal(isEventAnalyticsPublicationCommand({
    ...publication, team_results: [{ ...result, event_source_revision: 11 }],
  }), false);
  assert.equal(isEventAnalyticsPublicationCommand({
    ...publication, team_results: [{ ...result, event_key: "2025other" }],
  }), false);
  assert.equal(isEventAnalyticsPublicationCommand({
    ...publication, team_results: [result, result],
  }), false);
});
