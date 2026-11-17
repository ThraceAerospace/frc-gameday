import assert from "node:assert/strict";
import test from "node:test";
import { getCanonicalEventSnapshot } from "./serverSnapshot.ts";

test("server snapshot reader uses the configured runtime and preserves its revision", async () => {
  process.env.FIELDVIEW_RUNTIME_URL = "https://runtime.example.test";
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
  process.env.FIELDVIEW_RUNTIME_URL = "https://runtime.example.test";
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
