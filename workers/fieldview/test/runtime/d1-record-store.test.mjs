import assert from "node:assert/strict";
import test from "node:test";
import { D1RecordStore } from "../../src/runtime/d1-record-store.ts";

function createD1() {
  const tables = { discovery_records: new Map(), system_records: new Map() };
  let failBatchAt = -1;
  const db = {
    tables,
    setBatchFailureAt(index) { failBatchAt = index; },
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              const table = sql.match(/FROM (discovery_records|system_records)/)?.[1];
              if (!table) throw new Error("Unsupported first query: " + sql);
              const row = tables[table].get(values[0]);
              return row ? { value_json: row.value_json } : null;
            },
            async all() {
              const table = sql.match(/FROM (discovery_records|system_records)/)?.[1];
              if (!table) throw new Error("Unsupported all query: " + sql);
              const [prefixLength, prefix, cursor, limit] = values;
              const results = [...tables[table].entries()]
                .filter(([key]) => key.slice(0, prefixLength) === prefix && key > cursor)
                .sort(([a], [b]) => a.localeCompare(b))
                .slice(0, limit)
                .map(([record_key, row]) => ({ record_key, value_json: row.value_json }));
              return { results };
            },
            async run() {
              if (sql.startsWith("INSERT INTO")) {
                const table = sql.match(/INSERT INTO (discovery_records|system_records)/)?.[1];
                const [key, record_type, value_json, created_at, updated_at] = values;
                const old = tables[table].get(key);
                if (!old) tables[table].set(key, { record_type, value_json, created_at, updated_at });
                else if (old.value_json !== value_json || old.record_type !== record_type) {
                  tables[table].set(key, { ...old, record_type, value_json, updated_at });
                }
                return { meta: { changes: old && old.value_json === value_json ? 0 : 1 } };
              }
              if (sql.startsWith("DELETE FROM")) {
                const table = sql.match(/DELETE FROM (discovery_records|system_records)/)?.[1];
                return { meta: { changes: tables[table].delete(values[0]) ? 1 : 0 } };
              }
              throw new Error("Unsupported run query: " + sql);
            },
          };
        },
      };
    },
    async batch(statements) {
      const snapshot = Object.fromEntries(Object.entries(tables).map(([name, table]) =>
        [name, new Map([...table.entries()].map(([key, value]) => [key, { ...value }]))]));
      const results = [];
      try {
        for (let index = 0; index < statements.length; index += 1) {
          results.push(await statements[index].run());
          if (index === failBatchAt) throw new Error("Injected D1 batch failure");
        }
        return results;
      } catch (error) {
        for (const name of Object.keys(tables)) {
          tables[name].clear();
          for (const [key, value] of snapshot[name]) tables[name].set(key, value);
        }
        throw error;
      }
    },
  };
  return db;
}

test("D1 record store separates Discovery and System Records", async () => {
  const db = createD1();
  const store = new D1RecordStore(db);
  await store.put("discovery/events/2026.json", JSON.stringify({ year: 2026 }));
  await store.put("admin/runtime-jobs/job-1.json", JSON.stringify({ status: "running" }));
  assert.equal(db.tables.discovery_records.size, 1);
  assert.equal(db.tables.system_records.size, 1);
  assert.equal(await store.get("discovery/events/2026.json"), JSON.stringify({ year: 2026 }));
  assert.equal(await store.get("admin/runtime-jobs/job-1.json"), JSON.stringify({ status: "running" }));
});

test("D1 record store lists with prefix and exclusive cursor", async () => {
  const store = new D1RecordStore(createD1());
  for (const key of ["registry/events/2026.json", "registry/events/2027.json", "registry/teams/2026.json"]) {
    await store.put(key, "{}");
  }
  const first = await store.list({ prefix: "registry/events/", limit: 1 });
  assert.deepEqual([...first.keys()], ["registry/events/2026.json"]);
  const second = await store.list({ prefix: "registry/events/", startAfter: [...first.keys()][0], limit: 1 });
  assert.deepEqual([...second.keys()], ["registry/events/2027.json"]);
});

test("D1 record store skips identical writes and rejects invalid JSON", async () => {
  const db = createD1();
  const store = new D1RecordStore(db);
  await store.put("admin/jobs/one.json", JSON.stringify({ status: "queued" }));
  const before = db.tables.system_records.get("admin/jobs/one.json").updated_at;
  await store.put("admin/jobs/one.json", JSON.stringify({ status: "queued" }));
  assert.equal(db.tables.system_records.get("admin/jobs/one.json").updated_at, before);
  await assert.rejects(() => store.put("admin/jobs/bad.json", "not-json"));
});


test("D1 record store atomically publishes multiple records and deletes", async () => {
  const db = createD1();
  const store = new D1RecordStore(db);
  await store.put("discovery/partial-teams/2026/1.json", "{}");
  await store.putMany([
    ["registry/teams/2026.json", '["frc3461"]'],
    ["discovery/teams/2026.json", '{"complete":true}'],
  ], ["discovery/partial-teams/2026/1.json"]);
  assert.equal(await store.get("registry/teams/2026.json"), '["frc3461"]');
  assert.equal(await store.get("discovery/teams/2026.json"), '{"complete":true}');
  assert.equal(await store.get("discovery/partial-teams/2026/1.json"), undefined);
});

test("D1 record store rolls back a failed cross-table batch", async () => {
  const db = createD1();
  const store = new D1RecordStore(db);
  await store.put("admin/runtime-jobs/job-1.json", '{"status":"running"}');
  db.setBatchFailureAt(1);
  await assert.rejects(() => store.putMany([
    ["discovery/teams/2026.json", '{"generation":2}'],
    ["admin/runtime-jobs/job-1.json", '{"status":"completed"}'],
  ]), /Injected D1 batch failure/);
  assert.equal(await store.get("discovery/teams/2026.json"), undefined);
  assert.equal(await store.get("admin/runtime-jobs/job-1.json"), '{"status":"running"}');
});


test("D1 record store routes every documented key family to its owning table", async () => {
  const db = createD1();
  const store = new D1RecordStore(db);
  const discoveryKeys = [
    "discovery/current-season.json",
    "discovery/events/2026.json",
    "discovery/teams/2026.json",
    "discovery/team-pages/2026/1/0.json",
    "discovery/partial-teams/2026/1.json",
    "discovery/staging/2026/1.json",
    "discovery/event-chunks/2026/1/0.json",
    "registry/events/2026.json",
    "registry/teams/2026.json",
    "projections/events-this-week/current.json",
  ];
  const systemKeys = [
    "registry/runtime-events/2026cthar.json",
    "registry/runtime-teams/frc3461.json",
    "admin/discovery-jobs/2026.json",
    "admin/runtime-jobs/job-1.json",
    "admin/coverage-audits/2026.json",
    "workflow/event-analytics/2026cthar/run-1.json",
    "system/operational-history/entry-1.json",
  ];

  for (const key of discoveryKeys) await store.put(key, "{}");
  for (const key of systemKeys) await store.put(key, "{}");

  assert.deepEqual([...db.tables.discovery_records.keys()].sort(), discoveryKeys.sort());
  assert.deepEqual([...db.tables.system_records.keys()].sort(), systemKeys.sort());
});

test("D1 record store reads durable records through a newly constructed repository facade", async () => {
  const db = createD1();
  const writer = new D1RecordStore(db);
  await writer.put("discovery/current-season.json", '{"year":2026}');
  await writer.put("admin/runtime-jobs/job-1.json", '{"status":"running"}');

  // A new facade models a Worker restart: only the D1 binding survives.
  const afterRestart = new D1RecordStore(db);
  assert.equal(await afterRestart.get("discovery/current-season.json"), '{"year":2026}');
  assert.equal(await afterRestart.get("admin/runtime-jobs/job-1.json"), '{"status":"running"}');
  assert.deepEqual(
    [...(await afterRestart.list({ prefix: "admin/runtime-jobs/" })).keys()],
    ["admin/runtime-jobs/job-1.json"],
  );
});
