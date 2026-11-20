import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFieldViewEventSnapshot } from "@fieldview/domain";
import { getCanonicalEventSnapshot } from "./serverSnapshot.ts";

test("server snapshot reader uses the configured runtime and preserves its revision", async () => {
  process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL = "https://runtime.example.test";
  let requestedUrl = "";
  let requestedCache = "";
  const result = await getCanonicalEventSnapshot("2026test", async (url, init) => {
    requestedUrl = String(url);
    requestedCache = init?.cache ?? "";
    return Response.json(
      { event_key: "2026test", event: { key: "2026test" } },
      { headers: { "X-FieldView-Snapshot-Version": "12" } },
    );
  });
  assert.equal(requestedUrl, "https://runtime.example.test/events/2026test/snapshot");
  assert.equal(requestedCache, "no-store");
  assert.equal(result?.version, 12);
  assert.equal(result?.snapshot.event_key, "2026test");
});

test("server snapshot reader rejects mismatched event identity and invalid revisions", async () => {
  process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL = "https://runtime.example.test";
  const mismatched = await getCanonicalEventSnapshot("2026test", async () =>
    Response.json(
      { event_key: "2026other" },
      { headers: { "X-FieldView-Snapshot-Version": "1" } },
    ),
  );
  assert.equal(mismatched, null);

  const invalidVersion = await getCanonicalEventSnapshot("2026test", async () =>
    Response.json(
      { event_key: "2026test" },
      { headers: { "X-FieldView-Snapshot-Version": "invalid" } },
    ),
  );
  assert.equal(invalidVersion, null);
});

test("canonical event discovery reader validates year and returns domain events", async () => {
  process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL = "https://runtime.example.test";
  let requestedUrl = "";
  const { getCanonicalEventDiscovery } = await import("./serverSnapshot.ts");
  const events = await getCanonicalEventDiscovery(2026, async (url, init) => {
    requestedUrl = String(url);
    assert.equal(init?.cache, "force-cache");
    assert.deepEqual(init?.next, {
      revalidate: 300,
      tags: ["fieldview-event-discovery-2026"],
    });
    return Response.json({
      year: 2026,
      events: [{ key: "2026test", sources: { tba_event: { status: "available" } } }],
    });
  });
  assert.equal(requestedUrl, "https://runtime.example.test/events/discovery?year=2026");
  assert.equal(events?.[0].key, "2026test");

  const wrongYear = await getCanonicalEventDiscovery(2026, async () =>
    Response.json({ year: 2025, events: [] }),
  );
  assert.equal(wrongYear, null);
});

test("web workspace prebuild exposes the canonical domain normalizer at runtime", () => {
  const source = { status: "available", retrieved_at: "2026-01-02T03:04:05.000Z" };
  const snapshot = normalizeFieldViewEventSnapshot({
    event_key: "2026test",
    tba_event: { key: "2026test", name: "Test Event" },
    sources: {
      event: { tba_event: source },
      teams: {},
      event_teams: {},
      matches: {},
      playoff_alliances: {},
    },
  });
  assert.equal(snapshot.event?.key, "2026test");
  assert.equal(snapshot.event?.sources.tba_event.status, "available");
});

test("canonical team snapshot reader validates identity, year, and revision", async () => {
  process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL = "https://runtime.example.test";
  const { getCanonicalTeamSnapshot } = await import("./serverSnapshot.ts");
  let requestedUrl = "";
  const result = await getCanonicalTeamSnapshot("frc3461", 2026, async (url, init) => {
    requestedUrl = String(url);
    assert.equal(init?.cache, "no-store");
    return Response.json(
      { team_key: "frc3461", year: 2026, sources: {}, team: { key: "frc3461", team_number: 3461, sources: {} } },
      { headers: { "X-FieldView-Snapshot-Version": "7" } },
    );
  });
  assert.equal(requestedUrl, "https://runtime.example.test/teams/frc3461/snapshot?year=2026");
  assert.equal(result?.version, 7);
  assert.equal(result?.snapshot.team?.team_number, 3461);

  const wrongYear = await getCanonicalTeamSnapshot("frc3461", 2026, async () =>
    Response.json({ team_key: "frc3461", year: 2025, sources: {} }, {
      headers: { "X-FieldView-Snapshot-Version": "1" },
    }),
  );
  assert.equal(wrongYear, null);
});
