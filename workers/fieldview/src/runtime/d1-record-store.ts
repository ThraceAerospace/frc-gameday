export interface D1RecordStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  list<T = unknown>(options?: { prefix?: string; startAfter?: string; limit?: number }): Promise<Map<string, T>>;
  delete(key: string): Promise<boolean>;
}

function tableForKey(key: string): "discovery_records" | "system_records" {
  return key.startsWith("admin/") || key.startsWith("registry/runtime-")
    ? "system_records"
    : "discovery_records";
}

function recordTypeForKey(key: string): string {
  return key.split("/").slice(0, 2).join("/") || "root";
}

/** Minimal D1-backed key/value adapter used by the discovery and operations services. */
export class D1RecordStore implements D1RecordStorage {
  constructor(private readonly db: D1Database) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const table = tableForKey(key);
    const row = await this.db.prepare(`SELECT value_json FROM ${table} WHERE record_key = ?`)
      .bind(key).first<{ value_json: string }>();
    return row ? row.value_json as unknown as T : undefined;
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    const table = tableForKey(key);
    const serialized = String(value);
    // Validate before writing; both record tables intentionally contain JSON only.
    JSON.parse(serialized);
    const now = Date.now();
    await this.db.prepare(`INSERT INTO ${table} (record_key, record_type, value_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(record_key) DO UPDATE SET
        record_type = excluded.record_type,
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
      WHERE value_json <> excluded.value_json OR record_type <> excluded.record_type`)
      .bind(key, recordTypeForKey(key), serialized, now, now).run();
  }

  async list<T = unknown>(options: { prefix?: string; startAfter?: string; limit?: number } = {}): Promise<Map<string, T>> {
    const prefix = options.prefix ?? "";
    const limit = Math.max(1, Math.min(1001, options.limit ?? 1000));
    const cursor = options.startAfter ?? "";
    const tables = prefix
      ? [tableForKey(prefix)]
      : ["discovery_records", "system_records"] as const;
    const rows: Array<{ record_key: string; value_json: string }> = [];
    for (const table of tables) {
      const result = await this.db.prepare(`SELECT record_key, value_json FROM ${table}
        WHERE substr(record_key, 1, ?) = ? AND record_key > ?
        ORDER BY record_key LIMIT ?`)
        .bind(prefix.length, prefix, cursor).all<{ record_key: string; value_json: string }>();
      rows.push(...(result.results ?? []));
    }
    rows.sort((a, b) => a.record_key.localeCompare(b.record_key));
    return new Map(rows.slice(0, limit).map((row) => [row.record_key, row.value_json as unknown as T]));
  }

  async delete(key: string): Promise<boolean> {
    const table = tableForKey(key);
    const result = await this.db.prepare(`DELETE FROM ${table} WHERE record_key = ?`).bind(key).run();
    return (result.meta?.changes ?? 0) > 0;
  }
}
