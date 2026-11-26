export interface D1RecordStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  list<T = unknown>(options?: { prefix?: string; startAfter?: string; limit?: number }): Promise<Map<string, T>>;
  delete(key: string): Promise<boolean>;
}

type RecordTable = "discovery_records" | "system_records";

function tableForKey(key: string): RecordTable {
  return key.startsWith("admin/") || key.startsWith("system/") || key.startsWith("workflow/") || key.startsWith("registry/runtime-")
    ? "system_records"
    : "discovery_records";
}

function recordTypeForKey(key: string): string {
  return key.split("/").slice(0, 2).join("/") || "root";
}

/** Shared implementation for one of the two logical record repositories. */
class D1RecordRepository implements D1RecordStorage {
  constructor(private readonly db: D1Database, private readonly table: RecordTable) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = await this.db.prepare(`SELECT value_json FROM ${this.table} WHERE record_key = ?`)
      .bind(key).first<{ value_json: string }>();
    return row ? row.value_json as unknown as T : undefined;
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    const serialized = String(value);
    JSON.parse(serialized);
    const now = Date.now();
    await this.db.prepare(`INSERT INTO ${this.table} (record_key, record_type, value_json, created_at, updated_at)
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
    const result = await this.db.prepare(`SELECT record_key, value_json FROM ${this.table}
      WHERE substr(record_key, 1, ?) = ? AND record_key > ?
      ORDER BY record_key LIMIT ?`)
      .bind(prefix.length, prefix, cursor, limit).all<{ record_key: string; value_json: string }>();
    return new Map<string, T>((result.results ?? []).map((row): [string, T] => [row.record_key, row.value_json as unknown as T]));
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.db.prepare(`DELETE FROM ${this.table} WHERE record_key = ?`).bind(key).run();
    return (result.meta?.changes ?? 0) > 0;
  }
}

/** Discovery-owned records, backed by the discovery_records table. */
export class DiscoveryRecordsRepository extends D1RecordRepository {
  constructor(db: D1Database) { super(db, "discovery_records"); }
}

/** Workflow and operational records, backed by the system_records table. */
export class SystemRecordsRepository extends D1RecordRepository {
  constructor(db: D1Database) { super(db, "system_records"); }
}

/**
 * Compatibility-shaped key/value facade used by the in-process discovery service.
 * It routes discovery and operational key families to their separate repositories.
 */
export class D1RecordStore implements D1RecordStorage {
  private readonly discovery: DiscoveryRecordsRepository;
  private readonly system: SystemRecordsRepository;

  constructor(db: D1Database) {
    this.discovery = new DiscoveryRecordsRepository(db);
    this.system = new SystemRecordsRepository(db);
  }

  private repository(key: string): D1RecordStorage {
    return tableForKey(key) === "system_records" ? this.system : this.discovery;
  }

  get<T = unknown>(key: string): Promise<T | undefined> { return this.repository(key).get<T>(key); }
  put<T = unknown>(key: string, value: T): Promise<void> { return this.repository(key).put(key, value); }
  delete(key: string): Promise<boolean> { return this.repository(key).delete(key); }

  async list<T = unknown>(options: { prefix?: string; startAfter?: string; limit?: number } = {}): Promise<Map<string, T>> {
    const prefix = options.prefix ?? "";
    if (prefix) return this.repository(prefix).list<T>(options);
    const [discovery, system] = await Promise.all([
      this.discovery.list<T>(options), this.system.list<T>(options),
    ]);
    const merged: Array<[string, T]> = [...discovery.entries(), ...system.entries()]
      .sort(([a], [b]) => a.localeCompare(b));
    return new Map<string, T>(merged.slice(0, Math.max(1, options.limit ?? 1000)));
  }
}
