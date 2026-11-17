import assert from "node:assert/strict";
import test from "node:test";
import { StatboticsApiClient } from "../src/client.ts";
import { STATBOTICS_ENDPOINTS } from "../src/endpoints.ts";

test("builds encoded Statbotics resource paths", () => {
  assert.equal(STATBOTICS_ENDPOINTS.match("2026test_qm1/extra"), "/match/2026test_qm1%2Fextra");
  assert.equal(STATBOTICS_ENDPOINTS.teamYear(3461, 2026), "/team_year/3461/2026");
  assert.equal(STATBOTICS_ENDPOINTS.teamEvent(3461, "2026test/event"), "/team_event/3461/2026test%2Fevent");
});

test("builds collection filters and pagination using Statbotics query names", () => {
  assert.equal(
    STATBOTICS_ENDPOINTS.matches({ team: 3461, year: 2026, event: "2026test", elim: false }, 1000, 2000),
    "/matches?team=3461&year=2026&event=2026test&elim=false&limit=1000&offset=2000",
  );
  assert.equal(
    STATBOTICS_ENDPOINTS.teamEvents({ team: 3461, year: 2026 }, 1000, 0),
    "/team_events?team=3461&year=2026&limit=1000&offset=0",
  );
});

test("uses configured API base URL and preserves request headers and response", async () => {
  let captured;
  const response = new Response(null, { status: 304, headers: { ETag: '"v1"' } });
  const client = new StatboticsApiClient({
    baseUrl: "https://statbotics.example.test/",
    fetch: async (url, init) => {
      captured = { url, init };
      return response;
    },
  });
  const result = await client.request("/match/2026test_qm1", {
    headers: { "If-None-Match": '"v0"' },
  });
  assert.equal(captured.url, "https://statbotics.example.test/v3/match/2026test_qm1");
  assert.equal(new Headers(captured.init.headers).get("If-None-Match"), '"v0"');
  assert.equal(captured.init.cache, "no-store");
  assert.equal(result, response);
  assert.equal(result.status, 304);
});

test("rejects absolute and protocol-relative endpoint paths", () => {
  const client = new StatboticsApiClient({ fetch: async () => new Response() });
  assert.throws(() => client.request("https://example.test/match/1"), /provider-relative/);
  assert.throws(() => client.request("//example.test/match/1"), /provider-relative/);
});
