-- FieldView D1 baseline schema.
-- D1 is a simple record store with separate Discovery and System Records ownership.
-- Typed repository contracts validate record_type/value_json; timestamps are Unix milliseconds.

CREATE TABLE IF NOT EXISTS discovery_records (
  record_key TEXT PRIMARY KEY,
  record_type TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS system_records (
  record_key TEXT PRIMARY KEY,
  record_type TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
) STRICT;
