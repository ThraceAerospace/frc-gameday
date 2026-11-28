import assert from "node:assert/strict";
import test from "node:test";
import { acquireRuntimeBootstrap } from "../../src/jobs/runtime-bootstrap-acquisition.ts";
import { TBA_ENDPOINTS } from "../../../../packages/providers/tba/src/endpoints.ts";
import { FRC_COLORS_ENDPOINTS } from "../../../../packages/providers/frc-colors/src/endpoints.ts";

test("EventRuntime baseline bootstrap acquires only event metadata and its roster", async () => {
  const calls = [];
  const eventKey = "2027test";
  const bundle = await acquireRuntimeBootstrap({
    TBA_API_KEY: "test-key",
    fetcher: async (input) => {
      calls.push(String(input));
      return Response.json({ key: eventKey });
    },
  }, "event", eventKey, 2027, "test:event");
  assert.deepEqual(bundle.resources.map((resource) => resource.endpoint), [
    TBA_ENDPOINTS.event(eventKey),
    TBA_ENDPOINTS.eventTeams(eventKey),
  ]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.startsWith("https://www.thebluealliance.com/api/v3/")));
});

test("TeamRuntime baseline bootstrap acquires team, season events, and optional FRC-Colors only", async () => {
  const calls = [];
  const teamKey = "frc3461";
  const colorsEndpoint = FRC_COLORS_ENDPOINTS.team(3461);
  const bundle = await acquireRuntimeBootstrap({
    TBA_API_KEY: "test-key",
    fetcher: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith(colorsEndpoint)) throw new Error("FRC-Colors is temporarily unavailable");
      return Response.json({ key: teamKey });
    },
  }, "team", teamKey, 2027, "test:team");
  assert.deepEqual(bundle.resources.map((resource) => resource.endpoint), [
    TBA_ENDPOINTS.team(teamKey),
    TBA_ENDPOINTS.teamEvents(teamKey, 2027),
    colorsEndpoint,
  ]);
  assert.equal(calls.length, 3);
  assert.equal(bundle.resources[0].status, "available");
  assert.equal(bundle.resources[1].status, "available");
  assert.equal(bundle.resources[2].status, "failed",
    "optional FRC-Colors failure is represented without failing required TBA seed data");
  assert.ok(calls.some((url) => url.startsWith("https://api.frc-colors.com/v1/")));
  assert.ok(calls.every((url) => !url.includes("statbotics")));
});
