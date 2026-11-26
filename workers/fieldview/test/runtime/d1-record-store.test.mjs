import assert from "node:assert/strict";
import test from "node:test";
import { D1RecordStore } from "../../src/runtime/d1-record-store.ts";

function createD1() {
  const tables = { discovery_records: new Map(), system_records: new Map() };
  return {
    tables,
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
  };
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
